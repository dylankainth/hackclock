// Timer model. Everything here is pure: pass `now` in, get new state out.
//
// A run is a *timeline*, not a ticking counter. While running we store the
// absolute end time (controller clock, epoch ms); while paused or idle we store
// the remaining milliseconds. Every screen derives the digits from that, so a
// display only needs the timeline plus a clock offset to agree with the laptop.

export const WARN_DEFAULT_MS = 30_000;
export const CRITICAL_MS = 10_000;

export function uid() {
  return Math.random().toString(36).slice(2, 8);
}

export function makeTimer(label, durationMs, warnMs) {
  return {
    id: uid(),
    label: label || 'Timer',
    durationMs: Math.max(1000, Math.round(durationMs)),
    warnMs: warnMs == null ? defaultWarn(durationMs) : Math.max(0, Math.round(warnMs)),
  };
}

export function defaultWarn(durationMs) {
  // 20% of the slot, but never more than 30s and never less than 5s.
  return Math.min(WARN_DEFAULT_MS, Math.max(5_000, Math.round(durationMs * 0.2)));
}

export function idleRun(timer) {
  return { status: 'idle', endsAt: null, remainingMs: timer.durationMs, totalMs: timer.durationMs };
}

export function remainingAt(run, now) {
  return run.status === 'running' ? run.endsAt - now : run.remainingMs;
}

export function start(run, now) {
  if (run.status === 'running') return run;
  return { ...run, status: 'running', endsAt: now + run.remainingMs };
}

export function pause(run, now) {
  if (run.status !== 'running') return run;
  return { ...run, status: 'paused', remainingMs: run.endsAt - now, endsAt: null };
}

export function toggle(run, now) {
  return run.status === 'running' ? pause(run, now) : start(run, now);
}

export function reset(run, timer) {
  return idleRun(timer);
}

// Add or remove time without disturbing whether it is running.
export function adjust(run, deltaMs, now) {
  let next;
  if (run.status === 'running') next = { ...run, endsAt: run.endsAt + deltaMs };
  else next = { ...run, remainingMs: run.remainingMs + deltaMs };
  const rem = remainingAt(next, now);
  // Keep the progress bar sensible if someone adds time beyond the original slot.
  return { ...next, totalMs: Math.max(next.totalMs, rem) };
}

// 'idle' is neutral. While started: ok -> warn -> critical -> over.
export function phaseOf(status, remainingMs, warnMs) {
  if (status === 'idle') return 'idle';
  if (remainingMs <= 0) return 'over';
  // Red starts at 10s, or halfway through a short warning so amber still shows.
  if (warnMs > 0 && remainingMs <= Math.min(CRITICAL_MS, warnMs / 2)) return 'critical';
  if (remainingMs <= warnMs) return 'warn';
  return 'ok';
}

// Split a remaining-time value into what a clock face needs to draw.
// Positive time rounds up (so 0:00 appears exactly when time runs out); once
// past zero we count overtime upward.
export function clockParts(remainingMs) {
  let secs;
  let over = false;
  if (remainingMs > 0) secs = Math.ceil(remainingMs / 1000);
  else {
    secs = Math.floor(-remainingMs / 1000);
    over = true;
  }
  const capped = Math.min(secs, 99 * 3600 + 59 * 60 + 59);
  return {
    over,
    plus: over && capped > 0,
    h: Math.floor(capped / 3600),
    m: Math.floor((capped % 3600) / 60),
    s: capped % 60,
    totalSecs: capped,
  };
}

export function formatText(remainingMs) {
  const p = clockParts(remainingMs);
  const mm = String(p.m).padStart(2, '0');
  const ss = String(p.s).padStart(2, '0');
  const body = p.h > 0 ? `${p.h}:${mm}:${ss}` : `${p.m}:${ss}`;
  return (p.plus ? '+' : '') + body;
}

export function formatDuration(ms) {
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// What goes over the wire to displays. Small, self-contained, versioned.
export function snapshot({ v, timer, run, next }) {
  return {
    v,
    label: timer ? timer.label : '',
    durationMs: timer ? timer.durationMs : 0,
    warnMs: timer ? timer.warnMs : WARN_DEFAULT_MS,
    status: run.status,
    endsAt: run.endsAt,
    remainingMs: run.remainingMs,
    totalMs: run.totalMs,
    next: next || '',
  };
}

export const EMPTY_SNAPSHOT = {
  v: 0,
  label: '',
  durationMs: 180_000,
  warnMs: WARN_DEFAULT_MS,
  status: 'idle',
  endsAt: null,
  remainingMs: 180_000,
  totalMs: 180_000,
  next: '',
};
