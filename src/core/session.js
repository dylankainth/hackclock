// The two ends of a paired session.
//
// Messages (JSON over the data channel):
//   display    -> controller   hello {name}     once, on open
//   display    -> controller   ping  {c, r}     c = display clock, r = last rtt
//   controller -> display      pong  {c, s}     c echoed, s = controller clock
//   controller -> display      state {s}        full snapshot, whenever it changes
//
// The controller is the single writer, so the state needs no merge logic: a
// snapshot with a higher `v` simply replaces the previous one.

import { ClockSync } from './clock.js';

// ---------- controller side ----------

export class Hub {
  constructor({ getSnapshot, now = Date.now, staleMs = 15000 } = {}) {
    this.getSnapshot = getSnapshot;
    this.now = now;
    this.staleMs = staleMs;
    this.peers = [];
    this.listeners = [];
    this.seq = 0;
  }

  onChange(fn) {
    this.listeners.push(fn);
  }

  _emit() {
    this.listeners.forEach((f) => f(this.peers));
  }

  addLink(link) {
    const peer = { id: ++this.seq, name: `Display ${this.seq}`, link, rtt: null, lastSeen: this.now(), live: false };
    this.peers.push(peer);

    link.on('hello', (m) => {
      if (m.name) peer.name = String(m.name).slice(0, 40);
      peer.lastSeen = this.now();
      this._emit();
    });
    link.on('ping', (m) => {
      peer.lastSeen = this.now();
      if (typeof m.r === 'number') peer.rtt = m.r;
      link.send({ t: 'pong', c: m.c, s: this.now() });
      this._emit();
    });
    link.onOpen(() => {
      peer.live = true;
      link.send({ t: 'state', s: this.getSnapshot() });
      this._emit();
    });
    link.onClose(() => {
      peer.live = false;
      this.peers = this.peers.filter((p) => p !== peer);
      this._emit();
    });
    this._emit();
    return peer;
  }

  broadcast() {
    const msg = { t: 'state', s: this.getSnapshot() };
    for (const p of this.peers) p.link.send(msg);
  }

  isStale(peer) {
    return this.now() - peer.lastSeen > this.staleMs;
  }

  remove(peer) {
    peer.link.close();
  }
}

// ---------- display side ----------

export class DisplayClient {
  constructor(link, { name = 'Display', clock = Date.now, pingEveryMs = 4000, fastPings = 6, onState, onSync, onStatus } = {}) {
    this.link = link;
    this.sync = new ClockSync({ clock });
    this.clock = clock;
    this.state = null;
    this.onState = onState || (() => {});
    this.onSync = onSync || (() => {});
    this.onStatus = onStatus || (() => {});
    this.timer = null;
    this.sent = 0;
    this.fastPings = fastPings;
    this.pingEveryMs = pingEveryMs;

    link.on('state', (m) => {
      if (!this.state || m.s.v >= this.state.v) {
        this.state = m.s;
        this.onState(m.s);
      }
    });
    link.on('pong', (m) => {
      this.sync.addSample(m.c, m.s, this.clock());
      this.onSync(this.sync);
    });
    link.onOpen(() => {
      this.onStatus('live');
      link.send({ t: 'hello', name });
      this._ping();
      this._schedule();
    });
    link.onClose(() => {
      clearTimeout(this.timer);
      this.onStatus('offline');
    });
  }

  _ping() {
    this.link.send({ t: 'ping', c: this.clock(), r: this.sync.rtt });
    this.sent++;
  }

  _schedule() {
    // A quick burst at the start so the clock offset settles fast, then a slow beat.
    const delay = this.sent < this.fastPings ? 250 : this.pingEveryMs;
    this.timer = setTimeout(() => {
      if (!this.link.isOpen) return;
      this._ping();
      this._schedule();
    }, delay);
  }

  // The controller's current time, as best we can tell.
  controllerNow() {
    return this.sync.now();
  }
}
