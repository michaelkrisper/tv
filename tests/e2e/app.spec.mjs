import { expect, test } from '@playwright/test';

// Real data from the build: tests check behaviour, not individual programmes.

let errors;
test.beforeEach(({ page }) => {
  errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
});
test.afterEach(() => expect(errors).toEqual([]));

const tab = (page, i) => page.locator('#days button').nth(i);
const detail = (page) => page.locator('#detail');

// Swipe via touch events: Playwright only supports taps.
async function swipe(page, selector, dx) {
  await page.locator(selector).evaluate((el, dx) => {
    const y = innerHeight / 2;
    const x = innerWidth / 2 - dx / 2;
    const touch = (clientX) => new Touch({ identifier: 1, target: el, clientX, clientY: y });
    el.dispatchEvent(new TouchEvent('touchstart', { touches: [touch(x)], bubbles: true }));
    el.dispatchEvent(new TouchEvent('touchend', { changedTouches: [touch(x + dx)], bubbles: true }));
  }, dx);
}

// Touch drag through the given points (start, moves, end), one per frame
// like a real finger, so velocity-based gestures see a realistic speed.
async function drag(page, selector, points) {
  await page.locator(selector).evaluate(async (el, points) => {
    const touch = ([clientX, clientY]) => new Touch({ identifier: 1, target: el, clientX, clientY });
    const fire = (type, p, list) =>
      el.dispatchEvent(new TouchEvent(type, { [list]: [touch(p)], bubbles: true, cancelable: true }));
    fire('touchstart', points[0], 'touches');
    for (const p of points.slice(1)) {
      await new Promise((r) => setTimeout(r, 50));
      fire('touchmove', p, 'touches');
    }
    fire('touchend', points.at(-1), 'changedTouches');
  }, points);
}

test.describe('App', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('./');
    await expect(page.locator('#list .row[data-id]').first()).toBeVisible();
  });

  test('days: now, today, tomorrow, day after tomorrow', async ({ page }) => {
    await expect(page.locator('#days button')).toHaveCount(4);
    await expect(tab(page, 0)).toHaveText('Jetzt');
    for (const i of [0, 1, 2, 3]) {
      await tab(page, i).click();
      await expect(tab(page, i)).toHaveAttribute('aria-pressed', 'true');
      await expect(page.locator('#list .row[data-id]').first()).toBeVisible();
    }
  });

  test('swiping the list changes the day', async ({ page }) => {
    await tab(page, 1).click();
    await swipe(page, '#list', -150);
    await expect(tab(page, 2)).toHaveAttribute('aria-pressed', 'true');
    await swipe(page, '#list', 150);
    await expect(tab(page, 1)).toHaveAttribute('aria-pressed', 'true');
  });

  test('20:15 programme: details and "Danach" with thumbnails', async ({ page }) => {
    await tab(page, 1).click();
    const row = page.locator('#list .row[data-id]').first();
    const title = await row.locator('.t').textContent();
    await row.click();
    await expect(detail(page)).toHaveAttribute('open', '');
    await expect(detail(page).locator('h2')).toHaveText(title);
    const next = detail(page).locator('.next li');
    await expect(next.first()).toBeVisible();
    await expect(next.first().locator('.nt')).toBeAttached();

    // On to the next programme and back again
    const nextTitle = await next.first().locator('span').textContent();
    await next.first().click();
    await expect(detail(page).locator('h2')).toHaveText(nextTitle);
    await page.goBack();
    await expect(detail(page).locator('h2')).toHaveText(title);
  });

  test('returning to the app keeps the list when the day is unchanged', async ({ page }) => {
    const row = page.locator('#list .row[data-id]').first();
    await row.evaluate((el) => {
      el.dataset.keep = '1';
    });
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange', { bubbles: true })));
    await page.waitForTimeout(500);
    await expect(row).toHaveAttribute('data-keep', '1');
  });

  test('detail page: swiping right closes it', async ({ page }) => {
    await page.locator('#list .row[data-id]').first().click();
    await expect(detail(page)).toHaveAttribute('open', '');
    await swipe(page, '#detail', 150);
    await expect(detail(page)).not.toHaveAttribute('open', '');
  });

  test('detail page: back button closes it', async ({ page }) => {
    await page.locator('#list .row[data-id]').first().click();
    await detail(page).locator('.back').click();
    await expect(detail(page)).not.toHaveAttribute('open', '');
  });

  test('iOS status bar: opaque strip is on top at the front', async ({ page }) => {
    // Chromium has no safe-area inset: set the height as on the iPhone.
    // WebKit's check ignores pointer-events, elementFromPoint does not.
    await page.addStyleTag({ content: '.edge{height:59px;pointer-events:auto}' });
    // This is how WebKit checks (fixedContainerEdges): element in the middle, 4 px below the edge.
    const probe = await page.evaluate(() => {
      const el = document.elementFromPoint(innerWidth / 2, 4);
      const cs = getComputedStyle(el);
      return {
        cls: el.className,
        position: cs.position,
        widthRatio: el.getBoundingClientRect().width / innerWidth,
        alpha: cs.backgroundColor.startsWith('rgba') ? Number(cs.backgroundColor.split(',')[3]) : 1,
      };
    });
    expect(probe).toEqual({ cls: 'edge', position: 'fixed', widthRatio: 1, alpha: 1 });
  });

  test('theme: light, dark, automatic', async ({ page }) => {
    const html = page.locator('html');
    await page.locator('#gear').click();
    const seg = page.locator('#theme');

    await seg.getByText('Hell').click();
    await expect(html).toHaveAttribute('data-theme', 'light');
    await page.reload();
    await expect(html).toHaveAttribute('data-theme', 'light');

    await page.locator('#gear').click();
    await seg.getByText('Dunkel').click();
    await expect(html).toHaveAttribute('data-theme', 'dark');
    await expect(seg.getByText('Dunkel')).toHaveAttribute('aria-checked', 'true');

    await seg.getByText('Automatisch').click();
    await page.emulateMedia({ colorScheme: 'light' });
    await expect(html).toHaveAttribute('data-theme', 'light');
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(html).toHaveAttribute('data-theme', 'dark');
  });

  test('top inset: shifts content, strip and detail page, and persists', async ({ page }) => {
    const top = () => page.locator('.edge').evaluate((el) => el.getBoundingClientRect().height);
    const base = await top();
    await page.locator('#gear').click();
    await page.locator('#top').fill('24');
    await expect(page.locator('#topv')).toHaveText('24 px');
    expect(await top()).toBe(base + 24);
    await page.reload();
    expect(await top()).toBe(base + 24);

    await page.locator('#list .row[data-id]').first().click();
    await expect(detail(page)).toHaveAttribute('open', '');
    const hw = await detail(page)
      .locator('.hw')
      .evaluate((el) => el.getBoundingClientRect().top);
    expect(hw).toBe(base + 24);
  });
});

test.describe('Android', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      window.buzz = 0;
      navigator.vibrate = () => ++window.buzz;
    });
    await page.goto('./');
    await expect(page.locator('#list .row[data-id]').first()).toBeVisible();
  });

  test('platform, ripple on press, haptics on day change', async ({ page }) => {
    await expect(page.locator('html')).toHaveAttribute('data-os', 'android');
    await expect(page.locator('#list')).not.toHaveAttribute('aria-busy');
    const row = page.locator('#list .row[data-id]').first();
    const box = await row.boundingBox();
    await page.mouse.move(box.x + 20, box.y + 20);
    await page.mouse.down();
    await expect(row.locator('.rp')).toHaveCount(1);
    await page.mouse.up();
    await expect(row.locator('.rp')).toHaveCount(0);
    await page.locator('#detail .back').click();
    await tab(page, 2).click();
    expect(await page.evaluate(() => window.buzz)).toBeGreaterThan(0);
  });

  test('pull to refresh reloads the programme', async ({ page }) => {
    const req = page.waitForRequest((r) => r.url().endsWith('data/list.json'));
    await drag(page, '#list', [
      [200, 200],
      [200, 260],
      [200, 330],
      [200, 400],
    ]);
    await expect(page.locator('#ptr')).toHaveClass(/spin/);
    await req;
    await expect(page.locator('#ptr')).not.toHaveClass(/pull/);
  });
});

test.describe('iOS home screen app', () => {
  test.use({
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1',
  });
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => Object.defineProperty(navigator, 'standalone', { value: true }));
    await page.goto('./');
    await expect(page.locator('#list .row[data-id]').first()).toBeVisible();
  });

  test('platform and launch images', async ({ page, request }) => {
    await expect(page.locator('html')).toHaveAttribute('data-os', 'ios');
    const links = page.locator('link[rel=apple-touch-startup-image]');
    expect(await links.count()).toBeGreaterThan(10);
    const res = await request.get(await links.first().getAttribute('href'));
    expect(res.headers()['content-type']).toContain('image/png');
  });

  test('swipe from the left edge: short drag stays, long drag closes', async ({ page }) => {
    await page.locator('#list .row[data-id]').first().click();
    await expect(detail(page)).toHaveAttribute('open', '');
    await page.waitForTimeout(400);
    await drag(page, '#detail', [
      [5, 400],
      [20, 400],
      [30, 400],
      [40, 400],
      [50, 400],
    ]);
    await page.waitForTimeout(400);
    await expect(detail(page)).toHaveAttribute('open', '');
    await expect(detail(page)).toHaveAttribute('style', /transform: none|^$/);
    await drag(page, '#detail', [
      [5, 400],
      [60, 400],
      [200, 400],
      [320, 400],
    ]);
    await expect(detail(page)).not.toHaveAttribute('open', '');
    await expect(page.locator('#list')).not.toHaveAttribute('style', /translate/);
  });

  test('settings as a sheet: "Fertig" and dragging down close it', async ({ page }) => {
    const set = page.locator('#settings');
    await page.locator('#gear').click();
    await expect(set).toHaveAttribute('open', '');
    expect((await set.boundingBox()).y).toBeGreaterThan(0);
    await expect(set.locator('.grab')).toBeVisible();
    await set.getByText('Fertig').click();
    await expect(set).not.toHaveAttribute('open', '');

    await page.locator('#gear').click();
    await expect(set).toHaveAttribute('open', '');
    await page.waitForTimeout(500);
    await drag(page, '#settings .bar', [
      [200, 40],
      [200, 120],
      [200, 260],
    ]);
    await expect(set).not.toHaveAttribute('open', '');
  });
});

test.describe('Transfer size', () => {
  // Without the service worker so every request is visible here. The worker
  // only additionally precaches the shell (~15 KB).
  test.use({ serviceWorkers: 'block' });

  test('first start including prefetch stays under 2 MB', async ({ page }) => {
    let bytes = 0;
    let done = 0;
    page.on('requestfinished', async (r) => {
      const s = await r.sizes().catch(() => null);
      if (s) bytes += s.responseBodySize + s.responseHeadersSize;
      done++;
    });
    await page.goto('./');
    await expect(page.locator('#list .row[data-id]').first()).toBeVisible();
    // Until nothing arrives for a while: prefetching runs when idle
    // (requestIdleCallback with up to 3 s delay).
    for (let last = -1; last !== done; ) {
      last = done;
      await page.waitForTimeout(4000);
    }
    console.info(`First start: ${Math.round(bytes / 1024)} KB in ${done} requests`);
    expect(bytes).toBeLessThan(2 * 1024 * 1024);
  });
});
