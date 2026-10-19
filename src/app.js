import { Face } from './ui/face.js';
import { qrSvg, openCamera, scanStream, stopStream } from './ui/qr.js';
import { offerPairing, answerPairing, finishPairing, Link } from './core/rtc.js';
import { Hub, DisplayClient } from './core/session.js';
import { extractCode, codeToUrl, decodeSignal } from './core/codec.js';
import * as T from './core/timer.js';

const $ = (id) => document.getElementById(id);
const STORE_KEY = 'hackclock.v1';
const ROLE_KEY = 'hackclock.role';

function store(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* private mode etc. */
  }
  return null;
}

let toastTimer = null;
function toast(message, ms = 2800) {
  const el = $('toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), ms);
}

function setMsg(id, text, error = false) {
  const el = $(id);
  el.textContent = text || '';
  el.classList.toggle('error', !!error);
}

async function copyText(text, label = 'Copied') {
  try {
    await navigator.clipboard.writeText(text);
    toast(label);
  } catch {
    window.prompt('Copy this:', text);
  }
}

function iceServers() {
  // LAN-only by default: no third-party servers involved. Add ?stun to try
  // pairing across networks with a public STUN server.
  return new URLSearchParams(location.search).has('stun') ? [{ urls: 'stun:stun.l.google.com:19302' }] : [];
}

function shareBase() {
  const { protocol, hostname, origin, pathname } = location;
  const local = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname.endsWith('.localhost');
  return (protocol === 'https:' || protocol === 'http:') && !local ? origin + pathname : null;
}

function deviceName() {
  const ua = navigator.userAgent || '';
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android phone';
  return 'Display';
}

// ============================================================ views

const views = { landing: $('landing'), controller: $('controller'), display: $('display') };
let role = null;

function showView(name) {
  for (const k in views) views[k].hidden = k !== name;
}

function showLanding() {
  teardown();
  role = null;
  store(ROLE_KEY, null);
  showView('landing');
  document.title = 'Hackclock';
}

function teardown() {
  if (role === 'controller') leaveController();
  if (role === 'display') leaveDisplay();
}

for (const b of document.querySelectorAll('[data-role]')) {
  b.addEventListener('click', () => (b.dataset.role === 'controller' ? enterController() : enterDisplay()));
}
$('switchRole').addEventListener('click', () => {
  if (ctl.hub && ctl.hub.peers.some((p) => p.live) && !window.confirm('Disconnect the paired displays and switch role?')) return;
  showLanding();
});
document.querySelector('[data-action="switch"]').addEventListener('click', showLanding);

// ============================================================ controller

const ctl = {
  timers: [],
  idx: 0,
  run: null,
  v: 1,
  chime: true,
  hub: null,
  face: null,
  snapshot: null,
  wasOver: false,
  audio: null,
  pair: null,
  editing: null,
  raf: 0,
  tick: 0,
  lastTitle: '',
  peerSig: null,
  booted: false,
};

function defaultTimers() {
  return [T.makeTimer('Pitch', 180_000, 30_000), T.makeTimer('Q&A', 120_000, 30_000)];
}

function loadController() {
  let saved = null;
  try {
    saved = JSON.parse(store(STORE_KEY) || 'null');
  } catch {
    saved = null;
  }
  const ok = saved && Array.isArray(saved.timers) && saved.run && typeof saved.v === 'number';
  ctl.timers = ok ? saved.timers : defaultTimers();
  ctl.idx = ok ? Math.min(Math.max(0, saved.idx | 0), Math.max(0, ctl.timers.length - 1)) : 0;
  ctl.run = ok ? saved.run : T.idleRun(ctl.timers[0]);
  ctl.v = ok ? saved.v : 1;
  ctl.chime = ok ? saved.chime !== false : true;
}

function persist() {
  store(STORE_KEY, JSON.stringify({ timers: ctl.timers, idx: ctl.idx, run: ctl.run, v: ctl.v, chime: ctl.chime }));
}

const current = () => ctl.timers[ctl.idx] || null;

function buildSnapshot() {
  const next = ctl.timers[ctl.idx + 1];
  return T.snapshot({
    v: ctl.v,
    timer: current(),
    run: ctl.run,
    next: next ? `${next.label} ${T.formatDuration(next.durationMs)}` : '',
  });
}

// Every change goes through here: bump the version, save, tell the displays, redraw.
function commit() {
  ctl.v++;
  ctl.snapshot = buildSnapshot();
  ctl.wasOver = T.remainingAt(ctl.run, Date.now()) <= 0;
  persist();
  ctl.hub.broadcast();
  renderControls();
  renderTimerList();
}

function canSwitch() {
  return ctl.run.status === 'idle' || T.remainingAt(ctl.run, Date.now()) <= 0;
}

const actions = {
  toggle() {
    if (!current()) return;
    ensureAudio();
    ctl.run = T.toggle(ctl.run, Date.now());
    commit();
  },
  reset() {
    const t = current();
    if (!t) return;
    ctl.run = T.reset(ctl.run, t);
    commit();
  },
  nudge(seconds) {
    if (!current()) return;
    ctl.run = T.adjust(ctl.run, seconds * 1000, Date.now());
    commit();
  },
  select(i) {
    if (i === ctl.idx || i < 0 || i >= ctl.timers.length) return;
    if (!canSwitch()) return toast('Reset the current timer before switching.');
    ctl.idx = i;
    ctl.run = T.idleRun(ctl.timers[i]);
    commit();
  },
};

function setButton(btn, text, kbd) {
  btn.textContent = text;
  if (kbd) {
    const k = document.createElement('kbd');
    k.textContent = kbd;
    btn.append(' ', k);
  }
}

function renderControls() {
  const has = !!current();
  const s = ctl.run.status;
  setButton($('btnStart'), s === 'running' ? 'Pause' : s === 'paused' ? 'Resume' : 'Start', 'Space');
  setButton($('btnReset'), 'Reset', 'R');
  for (const id of ['btnStart', 'btnReset', 'btnPrev', 'btnNext']) $(id).disabled = !has;
  for (const b of document.querySelectorAll('[data-nudge]')) b.disabled = !has;
  $('btnPrev').disabled = !has || ctl.idx === 0;
  $('btnNext').disabled = !has || ctl.idx >= ctl.timers.length - 1;
  $('chimeToggle').checked = ctl.chime;
}

function renderTimerList() {
  const list = $('timerList');
  list.replaceChildren();
  ctl.timers.forEach((t, i) => {
    const li = document.createElement('li');
    li.className = 'timer-row';
    if (i === ctl.idx) li.setAttribute('aria-current', 'true');

    const pick = document.createElement('button');
    pick.className = 'timer-pick';
    pick.type = 'button';
    const name = document.createElement('span');
    name.className = 'timer-name';
    name.textContent = t.label;
    const len = document.createElement('span');
    len.className = 'timer-len';
    len.textContent = T.formatDuration(t.durationMs);
    pick.append(name, len);
    pick.addEventListener('click', () => actions.select(i));

    const edit = document.createElement('button');
    edit.className = 'timer-edit';
    edit.type = 'button';
    edit.textContent = 'Edit';
    edit.setAttribute('aria-label', `Edit ${t.label}`);
    edit.addEventListener('click', () => openTimerDialog(i));

    li.append(pick, edit);
    list.appendChild(li);
  });
  if (!ctl.timers.length) {
    const p = document.createElement('li');
    p.className = 'peers-empty';
    p.textContent = 'No timers yet.';
    list.appendChild(p);
  }
}

function renderPeers() {
  const strip = $('peerStrip');
  const peers = ctl.hub ? ctl.hub.peers : [];
  // Rebuilding the strip under a pointer can swallow a click, so only touch the
  // DOM when something the person can see has changed.
  const sig = peers
    .map((p) => `${p.id}|${p.name}|${p.live}|${ctl.hub.isStale(p)}|${p.rtt == null ? '' : Math.round(p.rtt)}`)
    .join(';');
  if (sig === ctl.peerSig) return;
  ctl.peerSig = sig;
  strip.replaceChildren();
  if (!peers.length) {
    const li = document.createElement('li');
    li.className = 'peers-empty';
    li.textContent = 'No display paired';
    strip.appendChild(li);
    return;
  }
  for (const p of peers) {
    const li = document.createElement('li');
    li.className = 'peer';
    const state = !p.live ? 'pending' : ctl.hub.isStale(p) ? 'stale' : 'live';
    li.dataset.state = state;
    const dot = document.createElement('span');
    dot.className = 'dot';
    const name = document.createElement('span');
    name.textContent = p.name;
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = state === 'pending' ? 'connecting…' : state === 'stale' ? 'no signal' : p.rtt != null ? `${Math.round(p.rtt)} ms` : 'live';
    const x = document.createElement('button');
    x.type = 'button';
    x.textContent = '×';
    x.setAttribute('aria-label', `Disconnect ${p.name}`);
    x.addEventListener('click', () => ctl.hub.remove(p));
    li.append(dot, name, meta, x);
    strip.appendChild(li);
  }
}

// ---- audio chime
function ensureAudio() {
  if (!ctl.audio) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) {
      try {
        ctl.audio = new AC();
      } catch {
        ctl.audio = null;
      }
    }
  }
  if (ctl.audio && ctl.audio.state === 'suspended') ctl.audio.resume().catch(() => {});
}

function chime() {
  if (!ctl.chime || !ctl.audio) return;
  const ac = ctl.audio;
  const t0 = ac.currentTime + 0.02;
  [880, 880, 660].forEach((freq, i) => {
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    const at = t0 + i * 0.24;
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(0.25, at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.2);
    osc.connect(gain).connect(ac.destination);
    osc.start(at);
    osc.stop(at + 0.22);
  });
}

// ---- frame + housekeeping loops
function controllerFrame() {
  if (role !== 'controller') return;
  ctl.face.update(ctl.snapshot, Date.now());
  ctl.raf = requestAnimationFrame(controllerFrame);
}

// Runs even when the tab is in the background (rAF does not), so the chime and
// the tab title keep working while the judge is looking at another window.
function controllerTick() {
  if (role !== 'controller') return;
  const now = Date.now();
  const rem = T.remainingAt(ctl.run, now);
  if (ctl.run.status === 'running' && rem <= 0 && !ctl.wasOver) chime();
  ctl.wasOver = rem <= 0;
  const t = current();
  const title = t && ctl.run.status !== 'idle' ? `${T.formatText(rem)} · ${t.label}` : 'Hackclock';
  if (title !== ctl.lastTitle) {
    ctl.lastTitle = title;
    document.title = title;
  }
  renderPeers();
}

function enterController() {
  teardown();
  role = 'controller';
  store(ROLE_KEY, 'controller');
  showView('controller');
  if (!ctl.booted) {
    ctl.booted = true;
    loadController();
    ctl.face = new Face($('ctlFace'));
    ctl.hub = new Hub({ getSnapshot: () => ctl.snapshot });
    ctl.hub.onChange(renderPeers);
  }
  ctl.snapshot = buildSnapshot();
  ctl.wasOver = T.remainingAt(ctl.run, Date.now()) <= 0;
  renderControls();
  renderTimerList();
  renderPeers();
  cancelAnimationFrame(ctl.raf);
  controllerFrame();
  clearInterval(ctl.tick);
  ctl.tick = setInterval(controllerTick, 500);
}

function leaveController() {
  cancelAnimationFrame(ctl.raf);
  clearInterval(ctl.tick);
  if ($('pairDlg').open) $('pairDlg').close();
  if (ctl.hub) for (const p of [...ctl.hub.peers]) ctl.hub.remove(p);
}

// ---- controls wiring
$('btnStart').addEventListener('click', actions.toggle);
$('btnReset').addEventListener('click', actions.reset);
$('btnPrev').addEventListener('click', () => actions.select(ctl.idx - 1));
$('btnNext').addEventListener('click', () => actions.select(ctl.idx + 1));
for (const b of document.querySelectorAll('[data-nudge]')) b.addEventListener('click', () => actions.nudge(Number(b.dataset.nudge)));
$('chimeToggle').addEventListener('change', (e) => {
  ctl.chime = e.target.checked;
  if (ctl.chime) ensureAudio();
  persist();
});

function typingTarget(el) {
  return el && el.closest && el.closest('input, textarea, select, [contenteditable="true"]');
}

function shortcut(e) {
  if (role !== 'controller' || e.metaKey || e.ctrlKey || e.altKey) return;
  if (typingTarget(e.target) || document.querySelector('dialog[open]')) return;
  const map = {
    ' ': () => actions.toggle(),
    r: () => actions.reset(),
    R: () => actions.reset(),
    ArrowLeft: () => actions.select(ctl.idx - 1),
    ArrowRight: () => actions.select(ctl.idx + 1),
    ArrowUp: () => actions.nudge(10),
    ArrowDown: () => actions.nudge(-10),
  };
  const fn = map[e.key];
  if (!fn) return;
  e.preventDefault();
  if (e.type === 'keydown' && !e.repeat) fn();
}
document.addEventListener('keydown', shortcut);
// Stop a focused button from also "clicking" when Space is released.
document.addEventListener('keyup', (e) => {
  if (role === 'controller' && e.key === ' ' && !typingTarget(e.target) && !document.querySelector('dialog[open]')) e.preventDefault();
});

// ---- timer dialog
function openTimerDialog(i) {
  ctl.editing = i;
  const t = i == null ? null : ctl.timers[i];
  $('timerDlgTitle').textContent = t ? 'Edit timer' : 'Add timer';
  $('tfLabel').value = t ? t.label : '';
  const total = t ? Math.round(t.durationMs / 1000) : 180;
  $('tfMin').value = Math.floor(total / 60);
  $('tfSec').value = total % 60;
  $('tfWarn').value = t ? Math.round(t.warnMs / 1000) : '';
  $('tfDelete').hidden = !t;
  $('tfError').hidden = true;
  $('timerDlg').showModal();
  $('tfLabel').focus();
}

$('addTimer').addEventListener('click', () => openTimerDialog(null));
$('tfCancel').addEventListener('click', () => $('timerDlg').close());

$('timerForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const label = $('tfLabel').value.trim();
  const min = Number($('tfMin').value);
  const sec = Number($('tfSec').value);
  const durationMs = (min * 60 + sec) * 1000;
  const warnRaw = $('tfWarn').value.trim();
  const fail = (m) => {
    $('tfError').textContent = m;
    $('tfError').hidden = false;
  };
  if (!label) return fail('Give the timer a name.');
  if (!Number.isFinite(durationMs) || durationMs < 1000) return fail('Set a length of at least one second.');
  const warnMs = warnRaw === '' ? T.defaultWarn(durationMs) : Math.max(0, Number(warnRaw) * 1000);

  if (ctl.editing == null) {
    ctl.timers.push(T.makeTimer(label, durationMs, warnMs));
    if (ctl.timers.length === 1) {
      ctl.idx = 0;
      ctl.run = T.idleRun(ctl.timers[0]);
    }
  } else {
    const t = ctl.timers[ctl.editing];
    Object.assign(t, { label, durationMs, warnMs });
    if (ctl.editing === ctl.idx && ctl.run.status === 'idle') ctl.run = T.idleRun(t);
  }
  $('timerDlg').close();
  commit();
});

$('tfDelete').addEventListener('click', () => {
  const i = ctl.editing;
  if (i == null) return;
  const wasActive = i === ctl.idx;
  if (wasActive && !canSwitch()) return toast('Reset the timer before removing it.');
  ctl.timers.splice(i, 1);
  if (i < ctl.idx) ctl.idx--;
  ctl.idx = Math.min(Math.max(0, ctl.idx), Math.max(0, ctl.timers.length - 1));
  if (wasActive) ctl.run = T.idleRun(ctl.timers[ctl.idx] || { durationMs: 180_000 });
  $('timerDlg').close();
  commit();
});

// ---- pairing dialog (controller side)
const pairDlg = $('pairDlg');

function resetPairUi() {
  $('offerQr').replaceChildren();
  setMsg('pairMsg', '');
  $('pairPaste').value = '';
  $('pairVideo').parentElement.dataset.on = 'false';
}

async function openPair() {
  resetPairUi();
  const session = { cancelled: false, connected: false, stream: null, stopScan: null, link: null, pc: null, offerCode: '', payload: '', answered: false };
  ctl.pair = session;
  pairDlg.showModal();

  // The camera is needed later to read the phone's code anyway. Opening it first
  // also lets browsers expose real LAN addresses instead of mDNS placeholders.
  setMsg('pairMsg', 'Starting camera…');
  try {
    session.stream = await openCamera('user');
    $('pairVideo').parentElement.dataset.on = 'true';
  } catch (e) {
    setMsg('pairMsg', e.message, true);
  }
  if (session.cancelled) return stopStream(session.stream);

  let offer;
  try {
    offer = await offerPairing({ iceServers: iceServers() });
  } catch (e) {
    setMsg('pairMsg', e.message || 'Could not start pairing.', true);
    return;
  }
  if (session.cancelled) return offer.pc.close();

  session.pc = offer.pc;
  session.offerCode = offer.code;
  const base = shareBase();
  session.payload = base ? codeToUrl(offer.code, base) : offer.code;
  try {
    $('offerQr').innerHTML = qrSvg(session.payload);
  } catch (e) {
    setMsg('pairMsg', 'Could not draw the pairing code.', true);
    return;
  }

  const link = new Link(offer.pc, offer.channel);
  session.link = link;
  const peer = ctl.hub.addLink(link);
  link.onOpen(() => {
    session.connected = true;
    toast(`${peer.name} connected`);
    if (pairDlg.open) pairDlg.close();
  });
  link.onClose(() => {
    if (!session.connected && !session.cancelled && pairDlg.open) {
      setMsg('pairMsg', "Couldn't connect. Check both devices are on the same Wi-Fi or hotspot, then close this and try again.", true);
    }
  });

  setMsg('pairMsg', session.stream ? 'Waiting for the phone to scan…' : 'Paste the phone’s code below once it shows one.');
  if (session.stream) {
    session.stopScan = await scanStream($('pairVideo'), session.stream, (text) => acceptAnswer(session, text, false));
    if (session.cancelled) session.stopScan();
  }
}

function acceptAnswer(session, text, loud) {
  if (session.answered || session.cancelled) return false;
  let code;
  try {
    code = extractCode(text);
    const d = decodeSignal(code);
    if (d.kind !== 'a') throw new Error('That is the laptop’s own code. Scan the code the phone shows.');
  } catch (e) {
    if (loud) setMsg('pairMsg', e.message, true);
    return false;
  }
  session.answered = true;
  setMsg('pairMsg', 'Got the phone’s code. Connecting…');
  finishPairing(session.pc, code).catch((e) => {
    session.answered = false;
    setMsg('pairMsg', e.message || 'That code did not work.', true);
  });
  return true;
}

pairDlg.addEventListener('close', () => {
  const s = ctl.pair;
  if (!s) return;
  s.cancelled = true;
  if (s.stopScan) s.stopScan();
  stopStream(s.stream);
  $('pairVideo').parentElement.dataset.on = 'false';
  if (!s.connected && s.link) s.link.close();
  else if (!s.connected && s.pc) s.pc.close();
  ctl.pair = null;
});

$('pairBtn').addEventListener('click', openPair);
$('pairPasteBtn').addEventListener('click', () => {
  if (ctl.pair && ctl.pair.pc) acceptAnswer(ctl.pair, $('pairPaste').value, true);
  else setMsg('pairMsg', 'Wait a moment, the laptop’s code is still being prepared.', true);
});
$('copyLink').addEventListener('click', () => ctl.pair && ctl.pair.payload && copyText(ctl.pair.payload, 'Link copied'));
$('copyOffer').addEventListener('click', () => ctl.pair && ctl.pair.offerCode && copyText(ctl.pair.offerCode, 'Code copied'));

// ============================================================ display

const disp = {
  face: null,
  snap: null,
  client: null,
  link: null,
  pc: null,
  stream: null,
  stopScan: null,
  raf: 0,
  hudTimer: 0,
  wake: null,
  answerCode: '',
  gen: 0, // bumps on every reset so late async results from an old attempt are ignored
  live: false,
};

function showDispScreen(name) {
  $('dispScan').hidden = name !== 'scan';
  $('dispAnswer').hidden = name !== 'answer';
  $('dispLive').hidden = name !== 'live';
  document.documentElement.dataset.screen = name;
}

function enterDisplay(opts = {}) {
  teardown();
  role = 'display';
  store(ROLE_KEY, 'display');
  showView('display');
  document.title = 'Hackclock';
  if (!disp.face) disp.face = new Face($('dispFace'));
  resetDisplay();
  if (opts.offer) acceptOffer(opts.offer);
}

function leaveDisplay() {
  applyRotation('');
  resetDisplay();
  releaseWake();
}

function resetDisplay() {
  disp.gen++;
  cancelAnimationFrame(disp.raf);
  clearTimeout(disp.hudTimer);
  if (disp.stopScan) disp.stopScan();
  stopStream(disp.stream);
  disp.stopScan = null;
  disp.stream = null;
  if (disp.link) disp.link.close();
  else if (disp.pc) disp.pc.close();
  disp.link = disp.pc = disp.client = null;
  disp.snap = null;
  disp.live = false;
  $('dispVideo').parentElement.dataset.on = 'false';
  $('dispQr').replaceChildren();
  setMsg('dispScanMsg', '');
  setMsg('dispAnswerMsg', 'Waiting for the laptop…');
  showDispScreen('scan');
}

async function startDisplayCamera() {
  if (disp.stream) return;
  const gen = disp.gen;
  setMsg('dispScanMsg', 'Starting camera…');
  try {
    const stream = await openCamera('environment');
    if (gen !== disp.gen) return stopStream(stream);
    disp.stream = stream;
    $('dispVideo').parentElement.dataset.on = 'true';
    setMsg('dispScanMsg', 'Point the camera at the code on the laptop.');
    disp.stopScan = await scanStream($('dispVideo'), stream, (text) => acceptOffer(text, true));
    if (gen !== disp.gen) disp.stopScan();
  } catch (e) {
    setMsg('dispScanMsg', e.message, true);
  }
}

// Returns true when the text was a valid laptop code (so a scanner can stop).
function acceptOffer(text, fromScan = false) {
  let code;
  try {
    code = extractCode(text);
    const d = decodeSignal(code);
    if (d.kind !== 'o') throw new Error('That is a phone code. Scan the code on the laptop instead.');
  } catch (e) {
    if (!fromScan) {
      showDispScreen('scan');
      setMsg('dispScanMsg', e.message, true);
    }
    return false;
  }
  runAnswer(code);
  return true;
}

async function runAnswer(code) {
  const gen = disp.gen;
  if (disp.stopScan) disp.stopScan();
  stopStream(disp.stream);
  disp.stopScan = null;
  disp.stream = null;
  $('dispVideo').parentElement.dataset.on = 'false';
  showDispScreen('answer');
  setMsg('dispAnswerMsg', 'Preparing your code…');

  let res;
  try {
    res = await answerPairing(code, { iceServers: iceServers() });
  } catch (e) {
    if (gen !== disp.gen) return;
    showDispScreen('scan');
    setMsg('dispScanMsg', e.message || 'Could not use that code.', true);
    return;
  }
  if (gen !== disp.gen) return res.pc.close();

  disp.pc = res.pc;
  disp.answerCode = res.code;
  $('dispQr').innerHTML = qrSvg(res.code);
  setMsg('dispAnswerMsg', 'Waiting for the laptop to scan this…');

  res.channelPromise.then((channel) => {
    if (gen !== disp.gen) return;
    const link = new Link(res.pc, channel);
    disp.link = link;
    disp.client = new DisplayClient(link, {
      name: deviceName(),
      onState: (s) => (disp.snap = s),
      onStatus: (st) => (st === 'live' ? goLive() : setLinkState('offline')),
    });
  });
  res.pc.addEventListener('connectionstatechange', () => {
    if (gen !== disp.gen) return;
    if (res.pc.connectionState === 'failed' && !disp.live) {
      setMsg('dispAnswerMsg', "Couldn't connect. Check both devices are on the same Wi-Fi or hotspot, then start over.", true);
    }
  });
  setTimeout(() => {
    if (gen === disp.gen && !disp.live && !$('dispAnswer').hidden) {
      setMsg('dispAnswerMsg', 'Still waiting. Hold this code up to the laptop’s camera, or use Copy code.');
    }
  }, 45_000);
}

function setLinkState(state) {
  const pill = $('hudLink');
  pill.dataset.state = state;
  pill.textContent = state === 'live' ? 'Connected' : 'Offline, still counting';
  if (state === 'offline') showHud(true);
}

function goLive() {
  disp.live = true;
  applyRotation(store(ROT_KEY) || '');
  showDispScreen('live');
  setLinkState('live');
  $('hudFull').hidden = !document.documentElement.requestFullscreen;
  keepAwake();
  showHud();
  cancelAnimationFrame(disp.raf);
  const frame = () => {
    if (role !== 'display' || !disp.live) return;
    const now = disp.client ? disp.client.controllerNow() : Date.now();
    disp.face.update(disp.snap, now);
    disp.raf = requestAnimationFrame(frame);
  };
  frame();
}

function showHud(sticky = false) {
  const hud = $('hud');
  hud.dataset.show = 'true';
  clearTimeout(disp.hudTimer);
  if (!sticky) disp.hudTimer = setTimeout(() => (hud.dataset.show = 'false'), 3500);
}

$('dispFace').addEventListener('pointerdown', () => {
  const hud = $('hud');
  if (hud.dataset.show === 'true') hud.dataset.show = 'false';
  else showHud();
  keepAwake();
});
$('hud').addEventListener('pointerdown', (e) => {
  e.stopPropagation();
  showHud();
});
$('hudFull').addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen().catch(() => {});
});
$('hudRepair').addEventListener('click', resetDisplay);

// Rotate: off -> quarter turn clockwise -> quarter turn counter-clockwise -> off.
const ROT_KEY = 'hackclock.rot';
const ROT_NEXT = { '': 'cw', cw: 'ccw', ccw: '' };
function applyRotation(value) {
  if (value) document.documentElement.dataset.rot = value;
  else delete document.documentElement.dataset.rot;
}
$('hudRotate').addEventListener('click', () => {
  const next = ROT_NEXT[document.documentElement.dataset.rot || ''];
  applyRotation(next);
  store(ROT_KEY, next || null);
});
$('dispCamBtn').addEventListener('click', startDisplayCamera);
$('dispAgain').addEventListener('click', resetDisplay);
$('dispCopy').addEventListener('click', () => disp.answerCode && copyText(disp.answerCode, 'Code copied'));
$('dispPasteBtn').addEventListener('click', () => acceptOffer($('dispPaste').value));

// Keep the phone awake while it is a display.
async function keepAwake() {
  if (!('wakeLock' in navigator) || disp.wake) return;
  try {
    disp.wake = await navigator.wakeLock.request('screen');
    $('hudAwake').hidden = false;
    disp.wake.addEventListener('release', () => {
      disp.wake = null;
      $('hudAwake').hidden = true;
    });
  } catch {
    /* needs a user gesture or is unsupported; we retry on the next tap */
  }
}

function releaseWake() {
  if (disp.wake) disp.wake.release().catch(() => {});
  disp.wake = null;
  $('hudAwake').hidden = true;
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && role === 'display' && disp.live) keepAwake();
});

// ============================================================ boot

function clearHash() {
  try {
    history.replaceState(null, '', location.pathname + location.search);
  } catch {
    /* some embedded contexts forbid it */
  }
}

function boot() {
  const hash = location.hash;
  if (hash.startsWith('#p=')) {
    // Opened from the laptop's QR with the phone's camera app.
    const code = extractCode(hash);
    clearHash();
    enterDisplay({ offer: code });
    return;
  }
  const saved = store(ROLE_KEY);
  if (saved === 'controller') enterController();
  else if (saved === 'display') enterDisplay();
  else showLanding();
}

window.addEventListener('hashchange', () => {
  if (location.hash.startsWith('#p=')) {
    const code = extractCode(location.hash);
    clearHash();
    enterDisplay({ offer: code });
  }
});

if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

boot();
