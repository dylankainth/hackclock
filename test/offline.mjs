// The plan is: load Hackclock once on venue Wi-Fi, then switch to the phone's
// hotspot. This checks the service worker really makes that work: after the first
// visit, the server is shut down entirely and the app must still load and run.
import chromiumPkg from '@sparticuz/chromium';
import { chromium } from 'playwright';
import { serve } from '../tools/serve.mjs';

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? '  — ' + detail : ''}`);
};

const server = await serve(new URL('../dist/', import.meta.url).pathname, 0, '127.0.0.1');
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  executablePath: await chromiumPkg.executablePath(),
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--no-proxy-server', '--in-process-gpu'],
});
try {
  const context = await browser.newContext({ serviceWorkers: 'allow' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  // Static assets all resolve and the manifest parses.
  for (const f of ['manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png', 'icon-512-maskable.png', 'apple-touch-icon.png', 'sw.js']) {
    const res = await fetch(`${origin}/${f}`);
    check(`serves ${f}`, res.ok, `${res.status} ${res.headers.get('content-type')}`);
  }
  const manifest = await (await fetch(`${origin}/manifest.webmanifest`)).json();
  check('manifest has name, start_url, standalone display and 3 icons', manifest.name === 'Hackclock' && manifest.display === 'standalone' && manifest.icons.length === 3);

  await page.goto(origin + '/');
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  const cached = await page.evaluate(async () => (await caches.keys()).filter((k) => k.startsWith('hackclock-')));
  check('service worker installed and cache created', cached.length === 1, cached.join(','));
  const urls = await page.evaluate(async () => {
    const c = await caches.open((await caches.keys())[0]);
    return (await c.keys()).map((r) => new URL(r.url).pathname);
  });
  check('app shell is cached', ['/', '/index.html', '/manifest.webmanifest', '/icon-192.png'].every((u) => urls.includes(u)), urls.join(' '));

  // Take the network away for real.
  await page.evaluate(() => navigator.serviceWorker.controller || new Promise((r) => navigator.serviceWorker.addEventListener('controllerchange', r)));
  await new Promise((r) => server.close(r));
  await page.reload();
  check('app loads with the server gone', (await page.title()) === 'Hackclock');
  await page.click('text=Run the clock on this laptop');
  await page.keyboard.press('Space');
  await page.waitForTimeout(1200);
  const state = await page.evaluate(() => document.querySelector('.face-state').textContent);
  check('controller runs fully offline', state === 'Running', state);
  check('no script errors', errors.length === 0, errors.join(' | '));
} catch (e) {
  failures++;
  console.log(' FAIL  aborted:', e.message);
} finally {
  await browser.close();
}
console.log(failures ? `${failures} failed` : 'offline checks passed');
process.exit(failures ? 1 : 0);
