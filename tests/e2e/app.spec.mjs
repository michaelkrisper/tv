import { expect, test } from '@playwright/test';

// Echte Daten aus dem Build: geprüft wird das Verhalten, nicht einzelne Sendungen.

let errors;
test.beforeEach(({ page }) => {
  errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
});
test.afterEach(() => expect(errors).toEqual([]));

const tab = (page, i) => page.locator('#days button').nth(i);
const detail = (page) => page.locator('#detail');

// Wischen per Touch-Events: Playwright kennt nur Tippen.
async function swipe(page, selector, dx) {
  await page.locator(selector).evaluate((el, dx) => {
    const y = innerHeight / 2;
    const x = innerWidth / 2 - dx / 2;
    const touch = (clientX) => new Touch({ identifier: 1, target: el, clientX, clientY: y });
    el.dispatchEvent(new TouchEvent('touchstart', { touches: [touch(x)], bubbles: true }));
    el.dispatchEvent(new TouchEvent('touchend', { changedTouches: [touch(x + dx)], bubbles: true }));
  }, dx);
}

test.describe('App', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('./');
    await expect(page.locator('#list .row[data-id]').first()).toBeVisible();
  });

  test('Tage: Jetzt, heute, morgen, übermorgen', async ({ page }) => {
    await expect(page.locator('#days button')).toHaveCount(4);
    await expect(tab(page, 0)).toHaveText('Jetzt');
    for (const i of [0, 1, 2, 3]) {
      await tab(page, i).click();
      await expect(tab(page, i)).toHaveAttribute('aria-pressed', 'true');
      await expect(page.locator('#list .row[data-id]').first()).toBeVisible();
    }
  });

  test('Wischen in der Liste wechselt den Tag', async ({ page }) => {
    await tab(page, 1).click();
    await swipe(page, '#list', -150);
    await expect(tab(page, 2)).toHaveAttribute('aria-pressed', 'true');
    await swipe(page, '#list', 150);
    await expect(tab(page, 1)).toHaveAttribute('aria-pressed', 'true');
  });

  test('20:15-Sendung: Details und "Danach" mit Bildchen', async ({ page }) => {
    await tab(page, 1).click();
    const row = page.locator('#list .row[data-id]').first();
    const title = await row.locator('.t').textContent();
    await row.click();
    await expect(detail(page)).toHaveAttribute('open', '');
    await expect(detail(page).locator('h2')).toHaveText(title);
    const next = detail(page).locator('.next li');
    await expect(next.first()).toBeVisible();
    await expect(next.first().locator('.nt')).toBeAttached();

    // Weiter zur nächsten Sendung und mit Zurück wieder hin
    const nextTitle = await next.first().locator('span').textContent();
    await next.first().click();
    await expect(detail(page).locator('h2')).toHaveText(nextTitle);
    await page.goBack();
    await expect(detail(page).locator('h2')).toHaveText(title);
  });

  test('Detailseite: nach rechts wischen schließt sie', async ({ page }) => {
    await page.locator('#list .row[data-id]').first().click();
    await expect(detail(page)).toHaveAttribute('open', '');
    await swipe(page, '#detail', 150);
    await expect(detail(page)).not.toHaveAttribute('open', '');
  });

  test('Detailseite: Zurück-Knopf schließt sie', async ({ page }) => {
    await page.locator('#list .row[data-id]').first().click();
    await detail(page).locator('.back').click();
    await expect(detail(page)).not.toHaveAttribute('open', '');
  });

  test('iOS-Statusleiste: deckender Streifen liegt oben vorne', async ({ page }) => {
    // Chromium kennt keinen Safe-Area-Abstand: Höhe wie auf dem iPhone setzen.
    // pointer-events ignoriert WebKits Prüfung, elementFromPoint nicht.
    await page.addStyleTag({ content: '.edge{height:59px;pointer-events:auto}' });
    // So prüft WebKit (fixedContainerEdges): Element in der Mitte, 4 px unter dem Rand.
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

  test('Darstellung: hell, dunkel, automatisch', async ({ page }) => {
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
});

test.describe('Datenmenge', () => {
  // Ohne Service Worker, damit jede Anfrage hier sichtbar ist. Der Worker
  // lädt zusätzlich nur die Hülle (~15 KB) vor.
  test.use({ serviceWorkers: 'block' });

  test('erster Start inklusive Vorladen bleibt unter 1 MB', async ({ page }) => {
    let bytes = 0;
    let done = 0;
    page.on('requestfinished', async (r) => {
      const s = await r.sizes().catch(() => null);
      if (s) bytes += s.responseBodySize + s.responseHeadersSize;
      done++;
    });
    await page.goto('./');
    await expect(page.locator('#list .row[data-id]').first()).toBeVisible();
    // Bis eine Weile nichts mehr nachkommt: das Vorladen läuft im Leerlauf.
    for (let last = -1; last !== done; ) {
      last = done;
      await page.waitForTimeout(2000);
    }
    console.info(`Erster Start: ${Math.round(bytes / 1024)} KB in ${done} Anfragen`);
    expect(bytes).toBeLessThan(1024 * 1024);
  });
});
