package main

import (
	"compress/gzip"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/andybalholm/brotli"
)

const day0 = int64(1768086000000) // 2026-01-11 00:00 in Vienna

var testDays = []string{"2026-01-11", "2026-01-12"}
var testChannels = [][]string{{"3+", "3+", "w"}, {"arte", "arte", ""}, {"orf1", "ORF 1", "k"}}

func at(h, m int64) int64 { return day0 + h*hour + m*60_000 }

// Every channel: one programme per hour from 00:00 to 06:00 the next morning,
// written latest first, as the reader has to sort them.
func fill(t *testing.T, file string, built int64) string {
	t.Helper()
	js := func(v any) string {
		raw, _ := json.Marshal(v)
		return string(raw)
	}
	type m = map[string]any
	days := []m{}
	var lines []string
	for i, date := range testDays {
		days = append(days, m{"date": date, "from": day0 + int64(i)*24*hour})
		for _, c := range testChannels {
			id := c[0]
			for h := 29; h >= 0; h-- {
				row := []any{h * 60, h*60 + 60, fmt.Sprintf("%s %s %d", id, date, h), "", "", nil, nil}
				lines = append(lines, fmt.Sprintf("s\t%s\t%s\t%d\t%d\t%s\t%s", date, id, h*60, h*60+60, js(row), js(m{"desc": fmt.Sprintf("d%d", h)})))
			}
			// the 20:15 item runs from 20:00 to 21:00
			row := []any{id + " 20:15", "20:00", "21:00", "", nil, "", nil}
			lines = append(lines, fmt.Sprintf("i\t%s\t%s\t%d\t%s\t%s", date, id, 21*60, js(row), js(m{"desc": id + " " + date})))
		}
	}
	head := js(m{"format": format, "built": built, "days": days, "channels": testChannels})
	tmp := file + ".tmp"
	if err := os.WriteFile(tmp, []byte(head+"\n"+strings.Join(lines, "\n")+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(tmp, file); err != nil {
		t.Fatal(err)
	}
	return file
}

func testStore(t *testing.T) *store {
	t.Helper()
	s, err := openStore(fill(t, filepath.Join(t.TempDir(), "a.tsv"), 1000))
	if err != nil {
		t.Fatal(err)
	}
	return s
}

type startAnswer struct {
	Built    int64                       `json:"built"`
	Days     []string                    `json:"days"`
	Channels [][]string                  `json:"channels"`
	Items    map[string]map[string][]any `json:"items"`
	Sdate    *string                     `json:"sdate"`
	Sched    map[string][][]any          `json:"sched"`
}

func parse[T any](t *testing.T, raw []byte) T {
	t.Helper()
	var v T
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatalf("%v in %s", err, raw)
	}
	return v
}

func eq(t *testing.T, got, want any) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestParseIDs(t *testing.T) {
	eq(t, parseIDs("orf1,3+,arte,orf1", maxChannels), []string{"3+", "arte", "orf1"})
	for _, bad := range []string{"", ",", "orf1,", "ORF1", "orf 1", "orf1'--", "../x", strings.Repeat("a", 41)} {
		if parseIDs(bad, maxChannels) != nil {
			t.Fatalf("%q accepted", bad)
		}
	}
	many := make([]string, maxChannels+1)
	for i := range many {
		many[i] = fmt.Sprint("c", i)
	}
	if parseIDs(strings.Join(many, ","), maxChannels) != nil {
		t.Fatal("too many accepted")
	}
	eq(t, len(parseIDs(strings.Join(many[1:], ","), maxChannels)), maxChannels)
	if parseIDs("a,b", 1) != nil {
		t.Fatal("two accepted where one is allowed")
	}
}

func TestParseQuery(t *testing.T) {
	eq(t, parseQuery("ch=a", "ch"), map[string]string{"ch": "a"})
	eq(t, parseQuery("date=d&ch=a", "ch", "date"), map[string]string{"ch": "a", "date": "d"})
	for _, bad := range [][]string{{"", "ch"}, {"ch=a&ch=b", "ch"}, {"ch=a&x=1", "ch"}, {"ch=a", "ch", "date"}} {
		if parseQuery(bad[0], bad[1:]...) != nil {
			t.Fatalf("%q accepted", bad[0])
		}
	}
}

func TestStart(t *testing.T) {
	s := testStore(t)
	r := parse[startAnswer](t, s.start([]string{"arte", "orf1", "unknown"}, at(21, 40)))
	eq(t, r.Built, int64(1000))
	eq(t, r.Days, testDays)
	eq(t, r.Channels, testChannels)
	eq(t, len(r.Items), 2)
	eq(t, len(r.Items["2026-01-12"]), 2)
	eq(t, r.Items["2026-01-11"]["orf1"][0], any("orf1 20:15"))
	eq(t, *r.Sdate, "2026-01-11")
	eq(t, len(r.Sched), 2)
	// 21:00 until 06:00 the next morning
	eq(t, len(r.Sched["orf1"]), 9)
	eq(t, r.Sched["orf1"][0][:3], []any{float64(21 * 60), float64(22 * 60), "orf1 2026-01-11 21"})
	// the order of the keys is part of the answer: channels sorted, days as built
	raw := string(s.start([]string{"arte", "orf1"}, at(21, 40)))
	if strings.Index(raw, `"sched":{"arte"`) < 0 || strings.Index(raw, `"items":{"2026-01-11":{"arte"`) < 0 {
		t.Fatalf("order: %.200s", raw)
	}
}

// After midnight the new day is read, before the first day nothing.
func TestStartDays(t *testing.T) {
	s := testStore(t)
	r := parse[startAnswer](t, s.start([]string{"orf1"}, at(24, 10)))
	eq(t, *r.Sdate, "2026-01-12")
	eq(t, r.Sched["orf1"][0][0], any(float64(0)))
	stale := parse[startAnswer](t, s.start([]string{"orf1"}, at(48+3, 0)))
	eq(t, *stale.Sdate, "2026-01-12")
	eq(t, stale.Sched["orf1"][0][0], any(float64(27*60)))
	early := parse[startAnswer](t, s.start([]string{"orf1"}, at(-1, 0)))
	if early.Sdate != nil || len(early.Sched) != 0 {
		t.Fatalf("before the first day: %v %v", early.Sdate, early.Sched)
	}
	eq(t, len(early.Items["2026-01-11"]), 1)
}

// No known channel gives empty lists, never other channels.
func TestStartUnknown(t *testing.T) {
	raw := string(testStore(t).start([]string{"nope"}, at(12, 0)))
	if !strings.Contains(raw, `"items":{"2026-01-11":{},"2026-01-12":{}},"sdate":"2026-01-11","sched":{}}`) {
		t.Fatal(raw)
	}
}

// 20:15 texts, "Danach" and the texts of the next hours.
func TestDetails(t *testing.T) {
	type text = map[string]string
	r := parse[struct {
		D     map[string]map[string]text    `json:"d"`
		N     map[string]map[string][][]any `json:"n"`
		Sdate string                        `json:"sdate"`
		X     map[string]map[string]text    `json:"x"`
	}](t, testStore(t).details([]string{"orf1"}, at(18, 59)))
	eq(t, r.D["2026-01-12"], map[string]text{"orf1": {"desc": "orf1 2026-01-12"}})
	next := r.N["2026-01-11"]["orf1"]
	eq(t, []any{next[0][0], next[1][0], next[2][0]}, []any{float64(21 * 60), float64(22 * 60), float64(23 * 60)})
	eq(t, len(next), 3)
	eq(t, r.Sdate, "2026-01-11")
	eq(t, r.X, map[string]map[string]text{"orf1": {"1080": {"desc": "d18"}, "1140": {"desc": "d19"}, "1200": {"desc": "d20"}}})
}

// One channel and day, texts in the order of the rows.
func TestDay(t *testing.T) {
	s := testStore(t)
	r := parse[struct {
		Rows [][]any             `json:"rows"`
		X    []map[string]string `json:"x"`
	}](t, s.day("3+", "2026-01-12"))
	eq(t, len(r.Rows), 30)
	eq(t, len(r.X), 30)
	eq(t, r.Rows[5][2], any("3+ 2026-01-12 5"))
	eq(t, r.X[5], map[string]string{"desc": "d5"})
	if s.hasDay("nope", "2026-01-12") || s.hasDay("orf1", "2026-01-13") || !s.hasDay("orf1", "2026-01-12") {
		t.Fatal("hasDay")
	}
}

func TestRouteETag(t *testing.T) {
	s := testStore(t)
	tag := func(path, query string, now int64) string { return route(s, path, query, now).etag }
	if tag("/api/start", "ch=orf1", at(12, 1)) != tag("/api/start", "ch=orf1", at(12, 59)) {
		t.Fatal("changes within the hour")
	}
	if tag("/api/start", "ch=orf1", at(12, 0)) == tag("/api/start", "ch=orf1", at(13, 0)) {
		t.Fatal("same in the next hour")
	}
	if tag("/api/day", "ch=orf1&date=2026-01-11", at(12, 0)) != tag("/api/day", "ch=orf1&date=2026-01-11", at(13, 0)) {
		t.Fatal("a day changes with the hour")
	}
}

type client struct {
	t    *testing.T
	base string
}

func (c client) do(method, path string, headers ...string) (*http.Response, []byte) {
	c.t.Helper()
	req, _ := http.NewRequest(method, c.base+path, nil)
	// Without this the transport asks for gzip itself and unpacks it.
	req.Header.Set("Accept-Encoding", "identity")
	for i := 0; i < len(headers); i += 2 {
		req.Header.Set(headers[i], headers[i+1])
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		c.t.Fatal(err)
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(res.Body)
	return res, body
}

func serve(t *testing.T, file string, now *int64) client {
	t.Helper()
	server := httptest.NewServer(newHandler(file, func() int64 { return *now }))
	t.Cleanup(server.Close)
	return client{t, server.URL}
}

// Validation and status codes, through HTTP as the server parses the URL.
func TestStatus(t *testing.T) {
	now := at(12, 0)
	c := serve(t, fill(t, filepath.Join(t.TempDir(), "a.tsv"), 1000), &now)
	for path, want := range map[string]int{
		"/api/start?ch=orf1,3%2B":                     200,
		"/api/details?ch=orf1":                        200,
		"/api/day?ch=orf1&date=2026-01-11":            200,
		"/api/day?ch=orf1&date=2026-01-13":            404,
		"/api/day?ch=nope&date=2026-01-11":            404,
		"/api/day?ch=orf1,arte&date=2026-01-11":       400,
		"/api/day?ch=orf1&date=2026-1-11":             400,
		"/api/day?ch=orf1":                            400,
		"/api/start":                                  400,
		"/api/start?ch=orf1&ch=arte":                  400,
		"/api/start?ch=orf1&from=0":                   400,
		"/api/start?ch=orf1%27%20OR%201=1":            400,
		"/api/start?ch=3+":                            400, // "+" must be sent as %2B
		"/api/start?ch=orf1;x=1":                      400,
		"/api/other?ch=orf1":                          404,
		"/api/start/?ch=orf1":                         404,
		"/api/start?ch=" + strings.Repeat("a,", 3000): 414,
	} {
		res, body := c.do("GET", path)
		if res.StatusCode != want {
			t.Errorf("%.60s: %d, want %d", path, res.StatusCode, want)
		}
		if want != 200 && (res.Header.Get("Cache-Control") != "no-store" || !strings.HasPrefix(string(body), `{"error":"`)) {
			t.Errorf("%.60s: %s %s", path, res.Header.Get("Cache-Control"), body)
		}
	}
}

// Compression, 304, methods, the kept answers, and a new file is picked up.
func TestHTTP(t *testing.T) {
	file := fill(t, filepath.Join(t.TempDir(), "live.tsv"), 1000)
	now := at(12, 0)
	c := serve(t, file, &now)
	built := func(body []byte) int64 { return parse[startAnswer](t, body).Built }

	res, body := c.do("GET", "/api/start?ch=orf1", "Accept-Encoding", "gzip, deflate, br, zstd")
	eq(t, res.StatusCode, 200)
	eq(t, res.Header.Get("Content-Encoding"), "br")
	eq(t, res.Header.Get("Cache-Control"), "public, max-age=60")
	eq(t, res.Header.Get("Vary"), "Accept-Encoding")
	eq(t, res.Header.Get("Content-Type"), "application/json")
	eq(t, res.Header.Get("Set-Cookie"), "")
	plain, _ := io.ReadAll(brotli.NewReader(strings.NewReader(string(body))))
	eq(t, built(plain), int64(1000))
	etag := res.Header.Get("ETag")

	same, body := c.do("GET", "/api/start?ch=orf1", "Accept-Encoding", "br", "If-None-Match", "W/"+etag)
	eq(t, same.StatusCode, 304)
	eq(t, same.Header.Get("ETag"), etag)
	eq(t, len(body), 0)
	// another encoding is another representation
	gz, body := c.do("GET", "/api/start?ch=orf1", "Accept-Encoding", "gzip", "If-None-Match", etag)
	eq(t, gz.StatusCode, 200)
	eq(t, gz.Header.Get("Content-Encoding"), "gzip")
	if gz.Header.Get("ETag") == etag {
		t.Fatal("gzip has the ETag of br")
	}
	zr, _ := gzip.NewReader(strings.NewReader(string(body)))
	unzipped, _ := io.ReadAll(zr)
	eq(t, string(unzipped), string(plain))
	id, body := c.do("GET", "/api/start?ch=orf1")
	eq(t, id.Header.Get("Content-Encoding"), "")
	eq(t, string(body), string(plain))

	// a repeated request gets the kept answer, the same in any channel order
	_, a := c.do("GET", "/api/start?ch=orf1,arte")
	_, b := c.do("GET", "/api/start?ch=arte,orf1")
	eq(t, string(a), string(b))
	if string(a) == string(plain) {
		t.Fatal("two channels answered like one")
	}

	now = at(13, 0)
	later, _ := c.do("GET", "/api/start?ch=orf1", "Accept-Encoding", "br", "If-None-Match", etag)
	eq(t, later.StatusCode, 200)
	if later.Header.Get("ETag") == etag {
		t.Fatal("same ETag in the next hour")
	}

	head, body := c.do("HEAD", "/api/start?ch=orf1")
	eq(t, head.StatusCode, 200)
	eq(t, len(body), 0)
	post, body := c.do("POST", "/api/start?ch=orf1")
	eq(t, post.StatusCode, 405)
	eq(t, post.Header.Get("Allow"), "GET, HEAD")
	eq(t, string(body), `{"error":"method not allowed"}`)

	// a file that cannot be read keeps the previous data
	time.Sleep(5 * time.Millisecond)
	os.WriteFile(file, []byte("{\"format\":2,\"channels\":[]}\nx\ty\n"), 0o644)
	_, body = c.do("GET", "/api/start?ch=orf1")
	eq(t, built(body), int64(1000))
	time.Sleep(5 * time.Millisecond)
	fill(t, file, 2000)
	_, body = c.do("GET", "/api/start?ch=orf1")
	eq(t, built(body), int64(2000))
}

func TestCacheIsBounded(t *testing.T) {
	now := at(12, 0)
	file := fill(t, filepath.Join(t.TempDir(), "a.tsv"), 1000)
	h := newHandler(file, func() int64 { return now })
	for i := 0; i < maxCached+50; i++ {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest("GET", fmt.Sprintf("/api/start?ch=c%d", i), nil))
		eq(t, rec.Code, 200)
	}
	eq(t, h.lru.Len(), maxCached)
	eq(t, len(h.byKey), maxCached)
}

func TestNoData(t *testing.T) {
	now := at(12, 0)
	res, body := serve(t, filepath.Join(t.TempDir(), "missing.tsv"), &now).do("GET", "/api/start?ch=orf1")
	eq(t, res.StatusCode, 503)
	eq(t, string(body), `{"error":"unavailable"}`)
}
