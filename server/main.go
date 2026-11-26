// Read-only programme API: answers with exactly what the selected channels
// need, in one request, from the file the build writes (scripts/data.mjs).
// The whole programme is kept in memory.
//
//	GET /api/start?ch=a,b,c     channel list, 20:15 items and today's schedule
//	                            from the current hour on: all the lists need
//	GET /api/details?ch=a,b,c   texts for the 20:15 items, their "Danach" and
//	                            the next hours of today (idle prefetch)
//	GET /api/day?ch=a&date=D    one channel, one whole day with texts (on tap)
//	GET /                       the app's page (TV_HTML) with the /api/start
//	                            answer for its default channels in it, so a
//	                            first visit needs no second request
//
// Public and unauthenticated: no cookies, no user data, nothing is logged.
// Every answer depends only on the build, the hour and the query, so it gets
// an ETag without being built and can be cached anywhere.
// One static binary; its only dependency is the Brotli encoder.
package main

import (
	"bytes"
	"compress/gzip"
	"container/list"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/andybalholm/brotli"
)

const (
	// Same number as FORMAT in scripts/data.mjs.
	format      = 2
	maxChannels = 100
	maxURL      = 4096
	hour        = 3600_000
	// Texts for programmes that start within this many hours; later ones load on tap.
	detailHours = 3
	nextRows    = 3
	// Compressed answers kept in memory; the API is public, so the number is capped.
	maxCached = 200
)

// ---- Data ------------------------------------------------------------------

// row and detail are JSON the build wrote; they are sent as they are.
type prog struct {
	start, stop int // minutes from 00:00 of the day
	row, detail json.RawMessage
}

type day struct {
	date string
	from int64 // 00:00 of that day in ms
}

type store struct {
	built    int64
	days     []day
	dates    []byte // the dates as a JSON array
	channels json.RawMessage
	known    map[string]bool
	items    map[string]map[string]prog   // date -> channel -> 20:15 item (stop only)
	sched    map[string]map[string][]prog // date -> channel -> rows by start
}

// The file: one line of JSON with the build, the days and the channels, then
// one line per 20:15 item ("i", date, channel, stop, row, detail) and schedule
// row ("s", date, channel, start, stop, row, detail), fields separated by
// tabs. JSON has no raw tabs or line breaks, so rows and details are used
// straight from the file's buffer, without parsing or copying them.
func openStore(file string) (*store, error) {
	raw, err := os.ReadFile(file)
	if err != nil {
		return nil, err
	}
	head, rest, _ := bytes.Cut(raw, []byte{'\n'})
	var meta struct {
		Format int   `json:"format"`
		Built  int64 `json:"built"`
		Days   []struct {
			Date string `json:"date"`
			From int64  `json:"from"`
		} `json:"days"`
		Channels json.RawMessage `json:"channels"`
	}
	if err := json.Unmarshal(head, &meta); err != nil {
		return nil, err
	}
	if meta.Format != format {
		return nil, fmt.Errorf("data format %d, expected %d", meta.Format, format)
	}
	var channels [][]string
	if err := json.Unmarshal(meta.Channels, &channels); err != nil {
		return nil, err
	}
	s := &store{
		built:    meta.Built,
		channels: meta.Channels,
		known:    make(map[string]bool, len(channels)),
		items:    map[string]map[string]prog{},
		sched:    map[string]map[string][]prog{},
	}
	for _, c := range channels {
		if len(c) > 0 {
			s.known[c[0]] = true
		}
	}
	dates := make([]string, len(meta.Days))
	for i, d := range meta.Days {
		s.days = append(s.days, day{d.Date, d.From})
		dates[i] = d.Date
		s.items[d.Date] = map[string]prog{}
		s.sched[d.Date] = map[string][]prog{}
	}
	s.dates, _ = json.Marshal(dates)
	for len(rest) > 0 {
		var line []byte
		line, rest, _ = bytes.Cut(rest, []byte{'\n'})
		f := bytes.Split(line, []byte{'\t'})
		bad := fmt.Errorf("bad line: %.80s", line)
		if len(f) < 6 || !s.known[string(f[2])] {
			return nil, bad
		}
		date, ch := string(f[1]), string(f[2])
		a, errA := strconv.Atoi(string(f[3]))
		switch {
		case string(f[0]) == "i" && len(f) == 6 && errA == nil:
			if m := s.items[date]; m != nil {
				m[ch] = prog{stop: a, row: f[4], detail: f[5]}
			}
		case string(f[0]) == "s" && len(f) == 7 && errA == nil:
			b, err := strconv.Atoi(string(f[4]))
			if err != nil {
				return nil, bad
			}
			if m := s.sched[date]; m != nil {
				m[ch] = append(m[ch], prog{a, b, f[5], f[6]})
			}
		default:
			return nil, bad
		}
	}
	for _, m := range s.sched {
		for _, rows := range m {
			sort.SliceStable(rows, func(a, b int) bool { return rows[a].start < rows[b].start })
		}
	}
	return s, nil
}

// The day "Jetzt" reads: the latest one that has begun. Its schedule runs
// until 06:00 the next morning, so it also covers the time after midnight
// until the next build. min = the current full hour in minutes of that day.
func (s *store) today(now int64) (date string, minute int, ok bool) {
	for i := len(s.days) - 1; i >= 0; i-- {
		if d := s.days[i]; d.from <= now {
			return d.date, int((now-d.from)/hour) * 60, true
		}
	}
	return "", 0, false
}

func (s *store) pick(ids []string) []string {
	mine := make([]string, 0, len(ids))
	for _, id := range ids {
		if s.known[id] {
			mine = append(mine, id)
		}
	}
	return mine
}

func key(b *bytes.Buffer, first *bool, k string) {
	if !*first {
		b.WriteByte(',')
	}
	*first = false
	b.WriteByte('"')
	b.WriteString(k)
	b.WriteString(`":`)
}

func writeList(b *bytes.Buffer, rows []prog, value func(prog) json.RawMessage) {
	b.WriteByte('[')
	for i, p := range rows {
		if i > 0 {
			b.WriteByte(',')
		}
		b.Write(value(p))
	}
	b.WriteByte(']')
}

func rowOf(p prog) json.RawMessage    { return p.row }
func detailOf(p prog) json.RawMessage { return p.detail }

// {"<date>":{"<channel>":<value>,...},...} over all days and the 20:15 items
// of the selected channels; an empty value leaves the channel out.
func (s *store) perDay(b *bytes.Buffer, mine []string, value func(date, ch string, it prog, b *bytes.Buffer) bool) {
	b.WriteByte('{')
	firstDay := true
	for _, d := range s.days {
		key(b, &firstDay, d.date)
		b.WriteByte('{')
		first := true
		for _, ch := range mine {
			it, ok := s.items[d.date][ch]
			if !ok {
				continue
			}
			mark := b.Len()
			was := first
			key(b, &first, ch)
			if !value(d.date, ch, it, b) {
				b.Truncate(mark)
				first = was
			}
		}
		b.WriteByte('}')
	}
	b.WriteByte('}')
}

func sdate(b *bytes.Buffer, date string, ok bool) {
	b.WriteString(`,"sdate":`)
	if ok {
		b.WriteByte('"')
		b.WriteString(date)
		b.WriteByte('"')
	} else {
		b.WriteString("null")
	}
}

func (s *store) start(ids []string, now int64) []byte {
	mine := s.pick(ids)
	date, minute, ok := s.today(now)
	var b bytes.Buffer
	b.WriteString(`{"built":`)
	b.WriteString(strconv.FormatInt(s.built, 10))
	b.WriteString(`,"days":`)
	b.Write(s.dates)
	b.WriteString(`,"channels":`)
	b.Write(s.channels)
	b.WriteString(`,"items":`)
	s.perDay(&b, mine, func(_, _ string, it prog, b *bytes.Buffer) bool {
		b.Write(it.row)
		return true
	})
	sdate(&b, date, ok)
	b.WriteString(`,"sched":{`)
	first := true
	for _, ch := range mine {
		var left []prog
		for _, p := range s.sched[date][ch] {
			if p.stop > minute {
				left = append(left, p)
			}
		}
		if len(left) == 0 {
			continue
		}
		key(&b, &first, ch)
		writeList(&b, left, rowOf)
	}
	b.WriteString("}}")
	return b.Bytes()
}

func (s *store) details(ids []string, now int64) []byte {
	mine := s.pick(ids)
	date, minute, ok := s.today(now)
	var b bytes.Buffer
	b.WriteString(`{"built":`)
	b.WriteString(strconv.FormatInt(s.built, 10))
	b.WriteString(`,"d":`)
	s.perDay(&b, mine, func(_, _ string, it prog, b *bytes.Buffer) bool {
		b.Write(it.detail)
		return true
	})
	b.WriteString(`,"n":`)
	s.perDay(&b, mine, func(d, ch string, it prog, b *bytes.Buffer) bool {
		rows := s.sched[d][ch]
		i := sort.Search(len(rows), func(i int) bool { return rows[i].start >= it.stop })
		rows = rows[i:min(len(rows), i+nextRows)]
		if len(rows) == 0 {
			return false
		}
		writeList(b, rows, rowOf)
		return true
	})
	sdate(&b, date, ok)
	b.WriteString(`,"x":{`)
	first := true
	for _, ch := range mine {
		inner := true
		for _, p := range s.sched[date][ch] {
			if p.stop <= minute || p.start >= minute+detailHours*60 {
				continue
			}
			if inner {
				key(&b, &first, ch)
				b.WriteByte('{')
			}
			key(&b, &inner, strconv.Itoa(p.start))
			b.Write(p.detail)
		}
		if !inner {
			b.WriteByte('}')
		}
	}
	b.WriteString("}}")
	return b.Bytes()
}

func (s *store) hasDay(id, date string) bool {
	_, ok := s.sched[date]
	return ok && s.known[id]
}

func (s *store) day(id, date string) []byte {
	rows := s.sched[date][id]
	var b bytes.Buffer
	b.WriteString(`{"rows":`)
	writeList(&b, rows, rowOf)
	b.WriteString(`,"x":`)
	writeList(&b, rows, detailOf)
	b.WriteByte('}')
	return b.Bytes()
}

// ---- Requests --------------------------------------------------------------

func validID(id string) bool {
	if len(id) < 1 || len(id) > 40 {
		return false
	}
	for i := 0; i < len(id); i++ {
		c := id[i]
		if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '+') {
			return false
		}
	}
	return true
}

func validDate(d string) bool {
	if len(d) != 10 {
		return false
	}
	for i := 0; i < 10; i++ {
		if i == 4 || i == 7 {
			if d[i] != '-' {
				return false
			}
		} else if d[i] < '0' || d[i] > '9' {
			return false
		}
	}
	return true
}

// "a,b,c" -> sorted unique ids, or nil if anything about it is off.
func parseIDs(value string, limit int) []string {
	if len(value) > maxURL {
		return nil
	}
	ids := strings.Split(value, ",")
	if len(ids) > limit {
		return nil
	}
	for _, id := range ids {
		if !validID(id) {
			return nil
		}
	}
	sort.Strings(ids)
	out := ids[:1]
	for _, id := range ids[1:] {
		if id != out[len(out)-1] {
			out = append(out, id)
		}
	}
	return out
}

// Exactly the expected parameters, each once.
func parseQuery(raw string, names ...string) map[string]string {
	q, err := url.ParseQuery(raw)
	if err != nil || len(q) != len(names) {
		return nil
	}
	out := make(map[string]string, len(names))
	for _, n := range names {
		if len(q[n]) != 1 {
			return nil
		}
		out[n] = q[n][0]
	}
	return out
}

type answer struct {
	status int
	key    string // the query in its canonical form
	etag   string
	maxAge int
	body   func() []byte // built lazily, so a 304 or a cached answer costs nothing
}

// hourly: the answer changes with the full hour
var routes = map[string]struct {
	names  []string
	hourly bool
	maxAge int
}{
	"/api/start":   {[]string{"ch"}, true, 60},
	"/api/details": {[]string{"ch"}, true, 300},
	"/api/day":     {[]string{"ch", "date"}, false, 300},
}

func route(s *store, path, rawQuery string, now int64) answer {
	r, ok := routes[path]
	if !ok {
		return answer{status: 404}
	}
	query := parseQuery(rawQuery, r.names...)
	if query == nil {
		return answer{status: 400}
	}
	limit := maxChannels
	if path == "/api/day" {
		limit = 1
	}
	ids := parseIDs(query["ch"], limit)
	date, hasDate := query["date"]
	if ids == nil || hasDate && !validDate(date) {
		return answer{status: 400}
	}
	a := answer{status: 200, maxAge: r.maxAge, key: path + "?" + strings.Join(ids, ",")}
	a.etag = strconv.Itoa(format) + "." + strconv.FormatInt(s.built, 10)
	if r.hourly {
		a.etag += "." + strconv.FormatInt(now/hour, 10)
	}
	switch path {
	case "/api/start":
		a.body = func() []byte { return s.start(ids, now) }
	case "/api/details":
		a.body = func() []byte { return s.details(ids, now) }
	default:
		if !s.hasDay(ids[0], date) {
			return answer{status: 404}
		}
		a.key += "&" + date
		a.body = func() []byte { return s.day(ids[0], date) }
	}
	return a
}

var errorText = map[int]string{400: "bad request", 404: "not found", 405: "method not allowed", 414: "uri too long"}

func encoding(accept string) string {
	gz := false
	for _, part := range strings.Split(accept, ",") {
		name, _, _ := strings.Cut(part, ";")
		switch strings.TrimSpace(name) {
		case "br":
			return "br"
		case "gzip":
			gz = true
		}
	}
	if gz {
		return "gzip"
	}
	return ""
}

func compress(body []byte, enc string) []byte {
	var b bytes.Buffer
	switch enc {
	case "br":
		// Kept in the cache afterwards, so a higher quality pays off.
		w := brotli.NewWriterLevel(&b, 9)
		w.Write(body)
		w.Close()
	case "gzip":
		w := gzip.NewWriter(&b)
		w.Write(body)
		w.Close()
	default:
		return body
	}
	return b.Bytes()
}

func matches(header, etag string) bool {
	for _, t := range strings.Split(header, ",") {
		t = strings.TrimSpace(t)
		if t == "*" || strings.TrimPrefix(t, "W/") == etag {
			return true
		}
	}
	return false
}

type cached struct {
	key, etag string
	body      []byte
}

// The file is looked at on every request: after a build the new one is
// loaded, and while it cannot be read the previous one keeps answering.
type handler struct {
	file  string
	html  string // the page, optional
	clock func() int64

	mu      sync.Mutex
	store   *store
	stamp   string
	lastErr string
	pg      *page
	// Answers only change with the build and the hour (both in the ETag), so the
	// compressed body is kept per query and encoding; least recently used go first.
	byKey map[string]*list.Element
	lru   *list.List
}

func newHandler(file, html string, clock func() int64) *handler {
	return &handler{file: file, html: html, clock: clock, byKey: map[string]*list.Element{}, lru: list.New()}
}

func (h *handler) current() (*store, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	info, err := os.Stat(h.file)
	if err == nil {
		// Each state of the file is tried once, also one that cannot be read.
		if stamp := fmt.Sprint(info.ModTime().UnixNano(), ":", info.Size()); stamp != h.stamp {
			h.stamp = stamp
			var next *store
			if next, err = openStore(h.file); err == nil {
				h.store = next
			}
		}
	}
	if err != nil {
		// Once per kind of failure, not once per request.
		if err.Error() != h.lastErr {
			log.Print(err)
		}
		h.lastErr = err.Error()
	}
	if h.store == nil {
		return nil, fmt.Errorf("no data")
	}
	return h.store, nil
}

func (h *handler) bodyOf(a answer, enc string) []byte {
	k := enc + ":" + a.key
	h.mu.Lock()
	if el := h.byKey[k]; el != nil {
		if c := el.Value.(*cached); c.etag == a.etag {
			h.lru.MoveToFront(el)
			h.mu.Unlock()
			return c.body
		}
	}
	h.mu.Unlock()
	body := compress(a.body(), enc)
	h.mu.Lock()
	defer h.mu.Unlock()
	if el := h.byKey[k]; el != nil {
		el.Value = &cached{k, a.etag, body}
		h.lru.MoveToFront(el)
		return body
	}
	h.byKey[k] = h.lru.PushFront(&cached{k, a.etag, body})
	if h.lru.Len() > maxCached {
		old := h.lru.Back()
		h.lru.Remove(old)
		delete(h.byKey, old.Value.(*cached).key)
	}
	return body
}

func fail(w http.ResponseWriter, status int) {
	text := errorText[status]
	if text == "" {
		text = "unavailable"
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	fmt.Fprintf(w, `{"error":%q}`, text)
}

// ---- Page ------------------------------------------------------------------

// The build leaves this marker in the page; the answer goes in its place.
const marker = "<!-- start -->"

// The default channels as the page itself defines them.
var defaults = regexp.MustCompile(`const DEFAULT = \[([^\]]*)\]`)

type page struct {
	stamp      string
	all        []byte
	head, tail []byte // around the marker, nil without one
	ids        []string
}

func readPage(file, stamp string) (*page, error) {
	b, err := os.ReadFile(file)
	if err != nil {
		return nil, err
	}
	p := &page{stamp: stamp, all: b}
	i := bytes.Index(b, []byte(marker))
	m := defaults.FindSubmatch(b)
	if i < 0 || m == nil {
		return p, nil
	}
	ids := strings.Split(strings.NewReplacer("'", "", `"`, "", " ", "", "\n", "").Replace(string(m[1])), ",")
	if ids = parseIDs(strings.Join(ids, ","), maxChannels); ids == nil {
		return p, nil
	}
	p.head, p.tail, p.ids = b[:i], b[i+len(marker):], ids
	return p, nil
}

// Like the programme file: looked at on every request, the previous version
// keeps answering while a new one cannot be read.
func (h *handler) page() (*page, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	info, err := os.Stat(h.html)
	if err == nil {
		if stamp := strconv.FormatInt(info.ModTime().UnixNano(), 36) + "-" + strconv.FormatInt(info.Size(), 36); h.pg == nil || stamp != h.pg.stamp {
			var next *page
			if next, err = readPage(h.html, stamp); err == nil {
				h.pg = next
			}
		}
	}
	if err != nil && h.pg == nil {
		return nil, err
	}
	return h.pg, nil
}

// The answer is put in as it is; only "</" is escaped so it cannot end the
// script element.
func (p *page) with(a answer) answer {
	out := answer{status: 200, key: "page", etag: "p." + p.stamp}
	if p.tail == nil || a.status != 200 {
		out.body = func() []byte { return p.all }
		return out
	}
	out.etag += "." + a.etag
	out.body = func() []byte {
		data := bytes.ReplaceAll(a.body(), []byte("</"), []byte(`<\/`))
		b := make([]byte, 0, len(p.head)+len(data)+len(p.tail)+64)
		b = append(b, p.head...)
		b = append(b, `<script type="application/json" id="start">`...)
		b = append(b, data...)
		b = append(b, "</script>"...)
		return append(b, p.tail...)
	}
	return out
}

func (h *handler) servePage(w http.ResponseWriter, r *http.Request) {
	p, err := h.page()
	if err != nil {
		fail(w, 503)
		return
	}
	a := answer{status: 503}
	if s, err := h.current(); err == nil && p.ids != nil {
		a = route(s, "/api/start", "ch="+strings.Join(p.ids, ","), h.clock())
	}
	// Always revalidated, like every other file of the app.
	h.send(w, r, p.with(a), "no-cache", "text/html; charset=utf-8")
}

// ---- HTTP ------------------------------------------------------------------

func (h *handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		fail(w, 405)
		return
	}
	if len(r.RequestURI) > maxURL {
		fail(w, 414)
		return
	}
	if h.html != "" && (r.URL.Path == "/" || r.URL.Path == "/index.html") {
		h.servePage(w, r)
		return
	}
	s, err := h.current()
	if err != nil {
		fail(w, 503)
		return
	}
	a := route(s, r.URL.Path, r.URL.RawQuery, h.clock())
	if a.status != 200 {
		fail(w, a.status)
		return
	}
	h.send(w, r, a, "public, max-age="+strconv.Itoa(a.maxAge), "application/json")
}

func (h *handler) send(w http.ResponseWriter, r *http.Request, a answer, cache, typ string) {
	enc := encoding(r.Header.Get("Accept-Encoding"))
	etag := `"` + a.etag + `"`
	if enc != "" {
		etag = `"` + a.etag + "." + enc + `"`
	}
	head := w.Header()
	head.Set("Cache-Control", cache)
	head.Set("ETag", etag)
	head.Set("Vary", "Accept-Encoding")
	if matches(r.Header.Get("If-None-Match"), etag) {
		w.WriteHeader(304)
		return
	}
	body := h.bodyOf(a, enc)
	if enc != "" {
		head.Set("Content-Encoding", enc)
	}
	head.Set("Content-Type", typ)
	head.Set("Content-Length", strconv.Itoa(len(body)))
	w.WriteHeader(200)
	if r.Method != http.MethodHead {
		w.Write(body)
	}
}

// The socket systemd passes in (tv-api.socket), else 127.0.0.1:PORT.
func listen() (net.Listener, error) {
	if os.Getenv("LISTEN_FDS") == "1" && os.Getenv("LISTEN_PID") == strconv.Itoa(os.Getpid()) {
		return net.FileListener(os.NewFile(3, "socket"))
	}
	port, err := strconv.Atoi(os.Getenv("PORT"))
	if err != nil {
		return nil, fmt.Errorf("PORT or a socket from systemd is required")
	}
	return net.Listen("tcp", "127.0.0.1:"+strconv.Itoa(port))
}

func main() {
	file := os.Getenv("TV_DATA")
	if file == "" {
		log.Fatal("TV_DATA is required")
	}
	log.SetFlags(0)
	ln, err := listen()
	if err != nil {
		log.Fatal(err)
	}
	server := &http.Server{
		Handler:           newHandler(file, os.Getenv("TV_HTML"), func() int64 { return time.Now().UnixMilli() }),
		MaxHeaderBytes:    8192,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       5 * time.Second,
		IdleTimeout:       5 * time.Second,
		WriteTimeout:      10 * time.Second,
	}
	// PORT=0 picks a free port; the line tells which (scripts/serve.mjs reads it).
	fmt.Printf("tv api on %s, %s\n", ln.Addr(), file)
	log.Fatal(server.Serve(ln))
}
