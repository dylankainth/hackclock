// End-to-end: two real WebRTC stacks (libdatachannel via node-datachannel)
// pair using nothing but the compact codes, then talk over the data channel.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import polyfill from 'node-datachannel/polyfill';
import { offerPairing, answerPairing, finishPairing, Link } from '../src/core/rtc.js';
import { Hub, DisplayClient } from '../src/core/session.js';
import * as T from '../src/core/timer.js';

const RTC = polyfill.RTCPeerConnection;

// libdatachannel keeps native handles alive; exit once the suite is done.
after(() => setTimeout(() => process.exit(process.exitCode || 0), 100).unref?.());
after(() => polyfill.cleanup?.());
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, ms = 8000, label = 'condition') {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await wait(25);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function pair() {
  const offer = await offerPairing({ RTC });
  const answer = await answerPairing(offer.code, { RTC });
  await finishPairing(offer.pc, answer.code);
  const displayChannel = await answer.channelPromise;
  return {
    offer,
    answer,
    controllerLink: new Link(offer.pc, offer.channel),
    displayLink: new Link(answer.pc, displayChannel),
  };
}

test('pairs from codes alone and exchanges messages both ways', async () => {
  const { offer, answer, controllerLink, displayLink } = await pair();
  console.log(`  offer code ${offer.code.length} chars, answer code ${answer.code.length} chars`);
  assert.ok(offer.code.length < 300 && answer.code.length < 300);

  await until(() => controllerLink.isOpen && displayLink.isOpen, 8000, 'channel open');

  const got = [];
  displayLink.on('hello', (m) => got.push(['display->controller', m]));
  controllerLink.on('hello', (m) => got.push(['controller->display', m]));
  displayLink.send({ t: 'hello', name: 'phone' });
  controllerLink.send({ t: 'hello', name: 'laptop' });
  await until(() => got.length === 2, 3000, 'messages');
  // Each side receives the other's hello.
  assert.ok(got.some(([d, m]) => d === 'display->controller' && m.name === 'laptop'));
  assert.ok(got.some(([d, m]) => d === 'controller->display' && m.name === 'phone'));

  controllerLink.close();
  await until(() => displayLink.closed, 5000, 'peer close propagating');
});

test('hub + display client: state snapshots and clock sync over a real channel', async () => {
  const { controllerLink, displayLink } = await pair();

  // The display's clock is deliberately 42 seconds ahead of the controller's.
  const SKEW = 42_000;
  const timer = { id: 'a', label: 'Pitch', durationMs: 180_000, warnMs: 30_000 };
  let run = T.idleRun(timer);
  let v = 1;
  const snap = () => T.snapshot({ v, timer, run, next: 'Q&A' });

  const hub = new Hub({ getSnapshot: snap });
  const states = [];
  const display = new DisplayClient(displayLink, {
    name: 'test phone',
    clock: () => Date.now() + SKEW,
    fastPings: 6,
    onState: (s) => states.push(s),
  });
  hub.addLink(controllerLink);

  await until(() => states.length >= 1, 8000, 'initial state');
  assert.equal(states[0].label, 'Pitch');
  assert.equal(states[0].status, 'idle');
  assert.equal(states[0].next, 'Q&A');

  // Controller starts the timer; display receives the new timeline.
  run = T.start(run, Date.now());
  v++;
  hub.broadcast();
  await until(() => states.at(-1).status === 'running', 3000, 'running state');

  // Clock sync: display should recover the controller's clock within a few ms.
  await until(() => display.sync.synced && display.sync.samples.length >= 4, 5000, 'clock samples');
  const err = Math.abs(display.controllerNow() - Date.now());
  console.log(`  clock error after sync: ${err.toFixed(1)} ms (rtt ${display.sync.rtt} ms, skew ${SKEW} ms)`);
  assert.ok(err < 20, `clock error ${err}`);

  // Both ends now agree on remaining time to within the clock error.
  const rControllerView = T.remainingAt(run, Date.now());
  const rDisplayView = T.remainingAt(display.state, display.controllerNow());
  assert.ok(Math.abs(rControllerView - rDisplayView) < 25, `${rControllerView} vs ${rDisplayView}`);

  // Pause freezes both.
  run = T.pause(run, Date.now());
  v++;
  hub.broadcast();
  await until(() => states.at(-1).status === 'paused', 3000, 'paused state');
  const frozen = T.remainingAt(display.state, display.controllerNow());
  await wait(200);
  assert.equal(T.remainingAt(display.state, display.controllerNow()), frozen);

  // The hub learned the display's name and RTT.
  await until(() => hub.peers[0].name === 'test phone', 3000, 'hello');
  await until(() => typeof hub.peers[0].rtt === 'number', 6000, 'rtt report');

  // A stale (lower version) snapshot arriving late is ignored.
  const before = display.state.v;
  controllerLink.send({ t: 'state', s: { ...snap(), v: before - 1, status: 'idle' } });
  await wait(150);
  assert.equal(display.state.v, before);
  assert.equal(display.state.status, 'paused');

  hub.remove(hub.peers[0]);
  await until(() => hub.peers.length === 0, 3000, 'peer removal');
  await until(() => displayLink.closed, 5000, 'display sees close');
});

test('second display can pair to the same hub', async () => {
  const hub = new Hub({ getSnapshot: () => T.EMPTY_SNAPSHOT });
  const a = await pair();
  const b = await pair();
  hub.addLink(a.controllerLink);
  hub.addLink(b.controllerLink);
  const seen = [0, 0];
  new DisplayClient(a.displayLink, { onState: () => seen[0]++ });
  new DisplayClient(b.displayLink, { onState: () => seen[1]++ });
  await until(() => seen[0] >= 1 && seen[1] >= 1, 8000, 'both displays get state');
  hub.broadcast();
  await until(() => seen[0] >= 2 && seen[1] >= 2, 3000, 'broadcast reaches both');
  assert.equal(hub.peers.length, 2);
  a.controllerLink.close();
  b.controllerLink.close();
});

test('a code from the wrong side is rejected with a clear message', async () => {
  const offer = await offerPairing({ RTC });
  await assert.rejects(() => finishPairing(offer.pc, offer.code), /offer, not an answer/);
  const answer = await answerPairing(offer.code, { RTC });
  await assert.rejects(() => answerPairing(answer.code, { RTC }), /answer, not an offer/);
  offer.pc.close();
  answer.pc.close();
});
