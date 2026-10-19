// Real-browser end-to-end tests: headless Chromium, two isolated browser
// profiles (controller + display) paired over real WebRTC, no signalling server.
//
//   node test/e2e.mjs            runs everything, writes screenshots to test/shots/
//
// The camera is faked: getUserMedia returns a canvas stream we paint QR codes onto,
// so the in-page scanner (jsQR) reads genuine camera-style frames.

import { mkdirSync } from 'node:fs';
import chromiumPkg from '@sparticuz/chromium';
import { chromium } from 'playwright';
import { serve } from '../tools/serve.mjs';

const SHOTS = new URL('./shots/', import.meta.url).pathname;
mkdirSync(SHOTS, { recursive: true });

let failures = 0;
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (!ok) failures++;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? '  — ' + detail : ''}`);
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10000, label = '') {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await wait(60);
  }
  throw new Error(`timeout: ${label}`);
}

// Replaces getUserMedia with a canvas the test can paint on; installs window.__feed(svg).
const FAKE_CAMERA = `
(() => {
  const canvas = document.createElement('canvas');
  canvas.width = 800; canvas.height = 600;
  const ctx = canvas.getContext('2d');
  let img = null;
  const paint = () => {
    ctx.fillStyle = '#2a2a2a'; ctx.fillRect(0, 0, 800, 600);
    if (img && img.complete) ctx.drawImage(img, 150, 50, 500, 500);
    requestAnimationFrame(paint);
  };
  paint();
  let stream = null;
  window.__feed = (svg) => {
    if (!svg) { img = null; return; }
    const i = new Image();
    i.onload = () => { img = i; };
    i.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  };
  window.__cameraOpens = 0;
  if (!navigator.mediaDevices) navigator.mediaDevices = {};
  navigator.mediaDevices.getUserMedia = async () => {
    window.__cameraOpens++;
    stream = canvas.captureStream(20);
    return stream;
  };
})();
`;

const FAKE_CLIPBOARD = `
(() => {
  if (!navigator.clipboard) {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: async (t) => { window.__clip = t; }, readText: async () => window.__clip || '' },
    });
  }
})();
`;

const SKEW = `
(() => { const real = Date.now.bind(Date); const off = window.__SKEW || 0; Date.now = () => real() + (window.__SKEW || 0); })();
`;

async function newPage(browser, { viewport = { width: 1280, height: 800 }, skew = 0, camera = true, mobile = false } = {}) {
  const context = await browser.newContext({
    viewport,
    hasTouch: mobile,
    isMobile: mobile,
    permissions: ['clipboard-read', 'clipboard-write'],
    serviceWorkers: 'block',
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.addInitScript(`window.__SKEW = ${skew};`);
  await page.addInitScript(SKEW);
  await page.addInitScript(FAKE_CLIPBOARD);
  if (camera) await page.addInitScript(FAKE_CAMERA);
  page.__errors = errors;
  page.__context = context;
  return page;
}

const faceState = (page, sel = '.face') =>
  page.evaluate((s) => {
    const f = document.querySelector(s);
    return f ? { phase: f.dataset.phase, paused: f.dataset.paused, aria: f.querySelector('.seg-svg').getAttribute('aria-label'), state: f.querySelector('.face-state').textContent, label: f.querySelector('.face-label').textContent } : null;
  }, sel);

// "2 minutes 47 seconds" -> 167
const secondsOf = (aria) => {
  const m = /(?:(\d+) hours )?(\d+) minutes (\d+) seconds/.exec(aria || '');
  return m ? Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
};

async function readClipboard(page) {
  return page.evaluate(() => navigator.clipboard.readText());
}

// ---------------------------------------------------------------- run

// Serve on the machine's LAN address (not loopback) so the app builds real share
// links like it would on hosted https. (TLS to non-loopback addresses is blocked in
// the sandbox this was developed in, so plain http is used; camera and clipboard
// are stubbed in-page instead of relying on a secure context.)
import { networkInterfaces } from 'node:os';
const lan = Object.values(networkInterfaces()).flat().find((i) => i.family === 'IPv4' && !i.internal)?.address || '127.0.0.1';
const server = await serve(new URL('../dist/', import.meta.url).pathname, 0, '0.0.0.0');
const port = server.address().port;
const base = `http://${lan}:${port}/`;
const exe = await chromiumPkg.executablePath();
// Minimal flags only: the package's defaults include --single-process (breaks
// multiple profiles) and --disable-web-security (would hide real-world failures).
// Our fake getUserMedia does not count as real camera permission, so we switch off
// mDNS candidate masking to mimic what a browser does once the camera is allowed.
const browser = await chromium.launch({
  executablePath: exe,
  headless: true,
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--in-process-gpu',
    '--font-render-hinting=none',
    '--autoplay-policy=no-user-gesture-required',
    '--disable-features=WebRtcHideLocalIpsWithMdns',
    '--no-proxy-server', // the sandbox's egress proxy must not see test traffic
  ],
});

try {
  // ===================================================== 1. QR-scan pairing, both directions
  console.log('\n1. Pair by scanning QR codes (fake cameras), display clock 37 s ahead');
  const laptop = await newPage(browser, { skew: 0 });
  const phone = await newPage(browser, { viewport: { width: 390, height: 844 }, skew: 37_000, mobile: true });

  await laptop.goto(base);
  await laptop.screenshot({ path: SHOTS + '01-landing.png' });
  await laptop.click('text=Run the clock on this laptop');
  await until(() => laptop.isVisible('#controller'), 5000, 'controller view');
  check('controller view opens with default timers', (await laptop.locator('.timer-row').count()) === 2);
  await laptop.screenshot({ path: SHOTS + '02-controller-idle.png' });

  await phone.goto(base);
  await phone.click('text=Show the clock on this phone');
  await phone.screenshot({ path: SHOTS + '03-phone-scan.png' });

  await laptop.click('#pairBtn');
  await until(() => laptop.locator('#offerQr svg').count(), 8000, 'offer QR');
  await laptop.screenshot({ path: SHOTS + '04-pair-dialog.png' });
  const offerSvg = await laptop.locator('#offerQr').innerHTML();
  const offerLen = (await laptop.evaluate(() => document.querySelector('#offerQr svg').getAttribute('viewBox').split(' ')[2]));
  check('offer QR is drawn', offerSvg.includes('<path'), `${offerLen}x${offerLen} modules`);
  check('laptop opened its camera before building the offer', (await laptop.evaluate(() => window.__cameraOpens)) >= 1);

  // The phone "points its camera" at the laptop's QR.
  await phone.click('#dispCamBtn');
  await until(() => phone.evaluate(() => window.__cameraOpens >= 1), 5000, 'phone camera open');
  await phone.evaluate((svg) => window.__feed(svg), offerSvg);
  await until(() => phone.locator('#dispQr svg').count(), 15000, 'phone scanned offer + showed answer QR');
  check('phone scanned the laptop QR and produced its own', true);
  await phone.screenshot({ path: SHOTS + '05-phone-answer.png' });

  // The laptop "points its camera" at the phone's QR.
  const answerSvg = await phone.locator('#dispQr').innerHTML();
  await laptop.evaluate((svg) => window.__feed(svg), answerSvg);
  await until(() => phone.isVisible('#dispLive'), 15000, 'phone goes live');
  check('devices connected over WebRTC with no server', true);
  await until(() => laptop.locator('.peer[data-state="live"]').count(), 8000, 'laptop shows live peer');
  check('pair dialog closed itself and the laptop lists the display', !(await laptop.isVisible('#pairDlg')));
  const peerText = await laptop.locator('.peer').first().innerText();
  check('display reports a friendly name', /Display/.test(peerText), peerText.replace(/\n/g, ' '));

  // ---------------- run the clock and compare both screens
  await laptop.keyboard.press('Space'); // start Pitch (3:00)
  await until(async () => (await faceState(phone, '#dispFace .face'))?.state === 'Running', 5000, 'phone shows running');
  await wait(1800); // let clock sync settle
  const diffs = [];
  for (let i = 0; i < 6; i++) {
    const [a, b] = await Promise.all([faceState(laptop, '#ctlFace .face'), faceState(phone, '#dispFace .face')]);
    diffs.push(Math.abs(secondsOf(a.aria) - secondsOf(b.aria)));
    await wait(350);
  }
  check('phone matches laptop to within 1 s despite a 37 s clock skew', Math.max(...diffs) <= 1, `diffs ${diffs.join(',')}`);
  await laptop.screenshot({ path: SHOTS + '06-controller-running.png' });
  await phone.screenshot({ path: SHOTS + '07-phone-running.png' });

  // pause / resume / reset / nudge / next
  await laptop.keyboard.press('Space');
  await until(async () => (await faceState(phone, '#dispFace .face'))?.paused === 'true', 4000, 'phone pauses');
  const frozenA = secondsOf((await faceState(phone, '#dispFace .face')).aria);
  await wait(1500);
  const frozenB = secondsOf((await faceState(phone, '#dispFace .face')).aria);
  check('pause freezes the phone', frozenA === frozenB, `${frozenA}s -> ${frozenB}s`);

  await laptop.click('[data-nudge="60"]');
  await until(async () => secondsOf((await faceState(phone, '#dispFace .face')).aria) === frozenA + 60, 4000, '+1 min reaches phone');
  check('+1 min while paused reaches the phone', true);

  await laptop.click('#btnReset');
  await until(async () => (await faceState(phone, '#dispFace .face'))?.state === 'Ready', 4000, 'phone resets');
  check('reset returns the phone to Ready at the full slot', secondsOf((await faceState(phone, '#dispFace .face')).aria) === 180);

  await laptop.keyboard.press('ArrowRight'); // Q&A 2:00
  await until(async () => (await faceState(phone, '#dispFace .face'))?.label === 'Q&A', 4000, 'phone switches timer');
  check('next timer switches label and length on the phone', secondsOf((await faceState(phone, '#dispFace .face')).aria) === 120);

  // ---------------- add a short timer and walk through the colour phases
  console.log('\n2. Phases on the phone');
  await laptop.click('#addTimer');
  await laptop.fill('#tfLabel', 'Lightning');
  await laptop.fill('#tfMin', '0');
  await laptop.fill('#tfSec', '14');
  await laptop.fill('#tfWarn', '8');
  await laptop.click('#tfSave');
  await laptop.click('.timer-row:nth-child(3) .timer-pick');
  await until(async () => (await faceState(phone, '#dispFace .face'))?.label === 'Lightning', 4000, 'phone shows new timer');
  check('a timer added on the laptop appears on the phone', true);
  await laptop.screenshot({ path: SHOTS + '08-controller-timers.png' });
  await laptop.keyboard.press('Space');
  const seen = [];
  const t0 = Date.now();
  while (Date.now() - t0 < 24_000) {
    const f = await faceState(phone, '#dispFace .face');
    if (seen[seen.length - 1] !== f.phase) seen.push(f.phase);
    if (f.phase === 'over' && secondsOf(f.aria) >= 2) break;
    await wait(120);
  }
  check('phone passes through ok, warn, critical and over', seen.join(' > ') === 'idle > ok > warn > critical > over' || seen.join(' > ') === 'ok > warn > critical > over', seen.join(' > '));
  const over = await faceState(phone, '#dispFace .face');
  check('overtime counts upward with a plus sign', /^plus /.test(over.aria), over.aria);
  check('status says time is up', over.state === 'Time is up');

  // Screenshots of each phase, taken while paused so they are stable.
  await laptop.keyboard.press('Space'); // pause the overtime run
  await laptop.click('#addTimer');
  await laptop.fill('#tfLabel', 'Demo');
  await laptop.fill('#tfMin', '1');
  await laptop.fill('#tfSec', '0');
  await laptop.fill('#tfWarn', '30');
  await laptop.click('#tfSave');
  await laptop.click('#btnReset');
  await laptop.click('.timer-row:nth-child(4) .timer-pick');
  await until(async () => (await faceState(phone, '#dispFace .face'))?.label === 'Demo', 4000, 'phone shows Demo');
  await phone.screenshot({ path: SHOTS + '09a-phone-idle.png' });
  await laptop.keyboard.press('Space');
  await laptop.keyboard.press('Space'); // started then paused at ~60 s
  for (const [phase, nudges] of [['ok', 0], ['warn', 3], ['critical', 2], ['over', 1]]) {
    for (let i = 0; i < nudges; i++) await laptop.click('[data-nudge="-10"]');
    await until(async () => (await faceState(phone, '#dispFace .face'))?.phase === phase, 4000, `phone ${phase}`);
    await phone.screenshot({ path: SHOTS + `09b-phone-${phase}.png` });
    if (phase === 'warn') await laptop.screenshot({ path: SHOTS + '09c-controller-warn.png' });
  }
  check('paused phases render on the phone', true);

  // Rotate control: a portrait phone can turn the clock to use its long edge.
  await phone.locator('#dispFace').dispatchEvent('pointerdown'); // wake the HUD
  await phone.click('#hudRotate');
  await wait(300);
  const rotBox = await phone.evaluate(() => {
    const r = document.querySelector('#dispFace .face').getBoundingClientRect();
    return { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), rot: document.documentElement.dataset.rot };
  });
  check('rotate turns the face to fill the portrait screen', rotBox.rot === 'cw' && rotBox.w === 390 && rotBox.h === 844 && rotBox.l === 0 && rotBox.t === 0, JSON.stringify(rotBox));
  await phone.screenshot({ path: SHOTS + '09d-phone-rotated.png' });
  await phone.locator('#dispFace').dispatchEvent('pointerdown'); // the HUD fades after a few seconds
  await phone.click('#hudRotate');
  check('second tap rotates the other way', (await phone.evaluate(() => document.documentElement.dataset.rot)) === 'ccw');
  await phone.click('#hudRotate');
  check('third tap returns to upright', (await phone.evaluate(() => document.documentElement.dataset.rot)) === undefined);

  // landscape view of the phone
  await phone.setViewportSize({ width: 844, height: 390 });
  await wait(400);
  await phone.screenshot({ path: SHOTS + '10-phone-landscape-over.png' });
  await phone.setViewportSize({ width: 390, height: 844 });

  // ---------------- controller reload keeps timers and a running clock
  console.log('\n3. Persistence');
  await laptop.keyboard.press('Space'); // pause
  await laptop.click('#btnReset');
  await laptop.keyboard.press('Space'); // start Lightning again
  await wait(2500);
  await laptop.reload();
  await until(() => laptop.isVisible('#controller'), 5000, 'controller back after reload');
  const after = await faceState(laptop, '#ctlFace .face');
  check('reload restores timers and the running clock', (await laptop.locator('.timer-row').count()) === 4 && after.state === 'Running', `${after.label} ${after.aria}`);
  await until(async () => (await phone.locator('#hudLink').getAttribute('data-state')) === 'offline', 20000, 'phone notices the controller left').catch(() => {});
  const offlineState = await phone.locator('#hudLink').getAttribute('data-state');
  check('phone flags the lost link and keeps counting', offlineState === 'offline', offlineState);
  const p1 = secondsOf((await faceState(phone, '#dispFace .face')).aria);
  await wait(2200);
  const p2 = secondsOf((await faceState(phone, '#dispFace .face')).aria);
  check('offline phone continues its countdown from the last timeline', p2 !== p1, `${p1}s -> ${p2}s`);

  // ---------------- 4. URL pairing + paste fallback with a second display
  console.log('\n4. Phone opens the laptop link directly (native camera path) and paste fallback');
  await laptop.click('#pairBtn');
  await until(() => laptop.locator('#offerQr svg').count(), 8000, 'offer QR #2');
  await laptop.click('#copyLink');
  const link = await readClipboard(laptop);
  check('copied link carries the pairing code in the hash', /#p=v1oX~/.test(link), link.slice(0, 60) + '…');
  const phone2 = await newPage(browser, { viewport: { width: 390, height: 844 }, mobile: true, camera: false });
  await phone2.goto(link);
  await until(() => phone2.locator('#dispQr svg').count(), 15000, 'phone2 answer QR via link');
  check('opening the link goes straight to the answer screen', await phone2.isVisible('#dispAnswer'));
  check('the code is removed from the address bar', !(await phone2.evaluate(() => location.hash)));
  await phone2.click('#dispCopy');
  const answerCode = await readClipboard(phone2);
  check('answer code is compact', answerCode.length < 200, `${answerCode.length} chars`);
  await laptop.locator('#pairDlg details.paste summary').click();
  await laptop.fill('#pairPaste', answerCode);
  await laptop.click('#pairPasteBtn');
  await until(() => phone2.isVisible('#dispLive'), 15000, 'phone2 live via paste');
  check('pasting the code connects the second display', true);
  await until(async () => (await laptop.locator('.peer[data-state="live"]').count()) >= 1, 8000, 'peer chip');
  check('laptop lists the new display', (await laptop.locator('.peer').count()) >= 1);

  // ---------------- 5. error handling
  console.log('\n5. Error handling');
  const phone3 = await newPage(browser, { viewport: { width: 390, height: 844 }, mobile: true, camera: false });
  await phone3.goto(base);
  await phone3.click('text=Show the clock on this phone');
  await phone3.locator('#dispScan details.paste summary').click();
  await phone3.fill('#dispPaste', 'hello world');
  await phone3.click('#dispPasteBtn');
  check('garbage code shows a readable error', /not a Hackclock pairing code/.test(await phone3.locator('#dispScanMsg').innerText()));
  await phone3.fill('#dispPaste', answerCode);
  await phone3.click('#dispPasteBtn');
  check('wrong-side code is explained', /Scan the code on the laptop/.test(await phone3.locator('#dispScanMsg').innerText()));
  await phone3.click('#dispCamBtn');
  await wait(300);
  check('missing camera API is handled', /camera|secure/i.test(await phone3.locator('#dispScanMsg').innerText()), await phone3.locator('#dispScanMsg').innerText());

  // ---------------- 6. page health
  console.log('\n6. Page health');
  for (const [n, p] of [['laptop', laptop], ['phone', phone], ['phone2', phone2], ['phone3', phone3]]) {
    const errs = p.__errors.filter((e) => !/Failed to load resource|favicon|manifest|sw\.js/i.test(e));
    check(`no uncaught errors on ${n}`, errs.length === 0, errs.slice(0, 2).join(' | '));
  }
} catch (e) {
  failures++;
  console.log(' FAIL  test run aborted:', e.message);
} finally {
  await browser.close();
  server.close();
}

console.log(`\n${results.filter((r) => r.ok).length} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
