// NTP-style offset estimation between this device and the controller.
//
// The display sends a ping stamped with its own clock (t0). The controller
// answers with its clock (ts). When the pong lands (t3) the display assumes the
// reply was stamped halfway through the round trip:
//
//   offset = ts - (t0 + t3) / 2        (controller time = local time + offset)
//
// Samples with the smallest round trip are the least contaminated by queueing
// delay, so we keep a sliding window and trust the best one.

export class ClockSync {
  constructor({ window = 8, clock = Date.now } = {}) {
    this.windowSize = window;
    this.clock = clock;
    this.samples = [];
    this.offset = 0;
    this.rtt = null;
    this.synced = false;
  }

  addSample(t0, ts, t3) {
    const rtt = t3 - t0;
    if (rtt < 0 || !Number.isFinite(rtt)) return;
    this.samples.push({ rtt, offset: ts - (t0 + t3) / 2 });
    if (this.samples.length > this.windowSize) this.samples.shift();
    let best = this.samples[0];
    for (const s of this.samples) if (s.rtt < best.rtt) best = s;
    this.offset = best.offset;
    this.rtt = best.rtt;
    this.synced = true;
  }

  // Best estimate of the controller's current time.
  now() {
    return this.clock() + this.offset;
  }
}
