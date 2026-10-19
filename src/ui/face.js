// The clock face. The controller shows one in its stage; a display shows one
// edge to edge. Both feed it a snapshot and "now" (in controller time) each frame.

import { SegmentClock, digitsFor, layoutFor } from './segments.js';
import { remainingAt, phaseOf, clockParts, EMPTY_SNAPSHOT } from '../core/timer.js';

const NS = 'http://www.w3.org/2000/svg';

function make(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

const STATE_TEXT = {
  idle: 'Ready',
  paused: 'Paused',
  running: 'Running',
  over: 'Time is up',
};

export class Face {
  constructor(host) {
    this.root = make('div', 'face');
    this.root.dataset.phase = 'idle';
    this.root.dataset.paused = 'false';

    const head = make('header', 'face-head');
    this.labelEl = make('h2', 'face-label');
    this.stateEl = make('p', 'face-state');
    head.append(this.labelEl, this.stateEl);

    const digits = make('div', 'face-digits');
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'seg-svg');
    svg.setAttribute('role', 'img');
    digits.appendChild(svg);
    this.svg = svg;

    const foot = make('footer', 'face-foot');
    const gauge = make('div', 'gauge');
    this.gaugeFill = make('i');
    gauge.appendChild(this.gaugeFill);
    this.nextEl = make('p', 'face-next');
    foot.append(gauge, this.nextEl);

    this.root.append(head, digits, foot);
    host.appendChild(this.root);

    this.clock = new SegmentClock(svg);
    this.cache = {};
  }

  set(key, value, apply) {
    if (this.cache[key] !== value) {
      this.cache[key] = value;
      apply(value);
    }
  }

  update(snap, now) {
    const s = snap || EMPTY_SNAPSHOT;
    const rem = remainingAt(s, now);
    const phase = phaseOf(s.status, rem, s.warnMs);
    const parts = clockParts(rem);
    const layout = layoutFor(s.durationMs, parts);

    this.clock.setLayout(layout);
    this.clock.render({ plus: parts.plus, digits: digitsFor(layout, parts) });

    this.set('phase', phase, (v) => (this.root.dataset.phase = v));
    this.set('paused', s.status === 'paused', (v) => (this.root.dataset.paused = String(v)));
    this.set('label', s.label || 'No timer selected', (v) => (this.labelEl.textContent = v));
    this.set('state', s.status === 'paused' ? 'paused' : phase === 'over' ? 'over' : s.status, (v) => (this.stateEl.textContent = STATE_TEXT[v]));
    this.set('next', s.next ? `Next: ${s.next}` : '', (v) => (this.nextEl.textContent = v));
    this.set('aria', `${parts.plus ? 'plus ' : ''}${parts.h ? parts.h + ' hours ' : ''}${parts.m} minutes ${parts.s} seconds`, (v) =>
      this.svg.setAttribute('aria-label', v),
    );

    const frac = s.totalMs > 0 ? Math.min(1, Math.max(0, rem / s.totalMs)) : 0;
    this.gaugeFill.style.transform = `scaleX(${frac.toFixed(4)})`;

    return { rem, phase, parts };
  }
}
