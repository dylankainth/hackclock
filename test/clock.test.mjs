import test from 'node:test';
import assert from 'node:assert/strict';
import { ClockSync } from '../src/core/clock.js';

// Simulate a display whose clock is `skew` ms ahead of the controller's, over a
// link with asymmetric, jittery delay.
function simulate(skew, samples, window = 8) {
  const sync = new ClockSync({ window });
  let seed = 12345;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  let controllerTime = 1_700_000_000_000;
  for (let i = 0; i < samples; i++) {
    const out = 2 + rand() * 40; // outbound delay ms (display -> controller)
    const back = 2 + rand() * 40;
    const t0 = controllerTime + skew; // display clock when ping is sent
    const ts = controllerTime + out; // controller clock when it replies
    const t3 = controllerTime + out + back + skew; // display clock at pong arrival
    sync.addSample(t0, ts, t3);
    controllerTime += 4000;
  }
  return sync;
}

test('recovers a large clock skew to within the link jitter', () => {
  for (const skew of [0, 5_000, -73_000, 3_600_000]) {
    const sync = simulate(skew, 20);
    assert.ok(sync.synced);
    // offset is "add to local to get controller time", so it should be -skew
    assert.ok(Math.abs(sync.offset + skew) < 25, `skew ${skew}: offset ${sync.offset}`);
  }
});

test('prefers the lowest round-trip sample', () => {
  const sync = new ClockSync({ window: 4 });
  sync.addSample(1000, 5000, 1400); // rtt 400, noisy
  sync.addSample(2000, 6001, 2004); // rtt 4, precise
  sync.addSample(3000, 7500, 3600); // rtt 600, noisy
  assert.equal(sync.rtt, 4);
  assert.equal(sync.offset, 6001 - 2002);
});

test('ignores impossible samples', () => {
  const sync = new ClockSync();
  sync.addSample(2000, 1000, 1500); // pong "before" ping
  sync.addSample(0, 0, NaN);
  assert.equal(sync.synced, false);
});

test('now() applies the offset to the local clock', () => {
  let t = 1000;
  const sync = new ClockSync({ clock: () => t });
  sync.addSample(1000, 6002, 1004); // offset = 6002 - 1002 = 5000
  assert.equal(sync.now(), 6000);
  t = 1500;
  assert.equal(sync.now(), 6500);
});
