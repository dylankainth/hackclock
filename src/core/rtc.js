// Serverless WebRTC pairing + a tiny JSON message channel on top of it.
//
//   controller: offerPairing()  -> shows `code` as a QR
//   display:    answerPairing(code) -> shows its own `code` as a QR
//   controller: finishPairing(pc, answerCode) -> channel opens, no server involved
//
// All functions take an optional `RTC` constructor so the same code runs under
// Node against node-datachannel in tests.

import { encodeSignal, signalToDescription } from './codec.js';

const CHANNEL_LABEL = 'hackclock';

function defaultRTC() {
  return globalThis.RTCPeerConnection;
}

function newPeerConnection(opts) {
  const RTC = opts.RTC || defaultRTC();
  if (!RTC) throw new Error('This browser does not support WebRTC.');
  return new RTC({ iceServers: opts.iceServers || [] });
}

// Resolve once ICE gathering finishes (or after a timeout, with whatever we have).
export function waitForGathering(pc, timeoutMs = 3000) {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve();
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    pc.addEventListener('icegatheringstatechange', () => {
      if (pc.iceGatheringState === 'complete') finish();
    });
    pc.addEventListener('icecandidate', (e) => {
      if (!e.candidate) finish();
    });
  });
}

export async function offerPairing(opts = {}) {
  const pc = newPeerConnection(opts);
  const channel = pc.createDataChannel(CHANNEL_LABEL, { ordered: true });
  await pc.setLocalDescription(await pc.createOffer());
  await waitForGathering(pc, opts.gatherTimeout);
  const code = encodeSignal('o', pc.localDescription.sdp, opts);
  return { pc, channel, code };
}

export async function answerPairing(offerCode, opts = {}) {
  const desc = signalToDescription(offerCode);
  if (desc.type !== 'offer') throw new Error('That code is an answer, not an offer. Scan the controller instead.');
  const pc = newPeerConnection(opts);
  const channelPromise = new Promise((resolve) => {
    pc.addEventListener('datachannel', (e) => resolve(e.channel));
  });
  await pc.setRemoteDescription(desc);
  await pc.setLocalDescription(await pc.createAnswer());
  await waitForGathering(pc, opts.gatherTimeout);
  const code = encodeSignal('a', pc.localDescription.sdp, opts);
  return { pc, channelPromise, code };
}

export async function finishPairing(pc, answerCode) {
  const desc = signalToDescription(answerCode);
  if (desc.type !== 'answer') throw new Error('That code is an offer, not an answer. Show this laptop the phone instead.');
  await pc.setRemoteDescription(desc);
}

// ---------- message channel ----------

// Wraps a data channel with JSON send/receive and lifecycle callbacks.
export class Link {
  constructor(pc, channel, opts = {}) {
    this.pc = pc;
    this.channel = channel;
    this.handlers = new Map();
    this.openHandlers = [];
    this.closeHandlers = [];
    this.closed = false;
    this.opened = false;

    channel.addEventListener('message', (e) => {
      let msg;
      try {
        msg = JSON.parse(typeof e.data === 'string' ? e.data : new TextDecoder().decode(e.data));
      } catch {
        return;
      }
      const fn = this.handlers.get(msg.t);
      if (fn) fn(msg);
    });
    channel.addEventListener('open', () => this._opened());
    channel.addEventListener('close', () => this._closed());
    // 'disconnected' often heals by itself on a flaky LAN, so give it a few
    // seconds before treating the link as gone. 'failed' and 'closed' are final.
    let graceTimer = null;
    pc.addEventListener('connectionstatechange', () => {
      const s = pc.connectionState;
      if (s === 'failed' || s === 'closed') this._closed();
      else if (s === 'disconnected') {
        clearTimeout(graceTimer);
        graceTimer = setTimeout(() => {
          if (pc.connectionState === 'disconnected') this._closed();
        }, opts.disconnectGraceMs ?? 8000);
      } else clearTimeout(graceTimer);
    });
    if (channel.readyState === 'open') this._opened();
  }

  get isOpen() {
    return !this.closed && this.channel.readyState === 'open';
  }

  on(type, fn) {
    this.handlers.set(type, fn);
    return this;
  }

  // Runs fn once the channel is open (immediately if it already is).
  onOpen(fn) {
    if (this.opened) fn();
    else this.openHandlers.push(fn);
    return this;
  }

  onClose(fn) {
    this.closeHandlers.push(fn);
    return this;
  }

  send(msg) {
    if (!this.isOpen) return false;
    try {
      this.channel.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }

  close() {
    try {
      this.channel.close();
    } catch {
      /* already closed */
    }
    try {
      this.pc.close();
    } catch {
      /* already closed */
    }
    this._closed();
  }

  _opened() {
    if (this.opened || this.closed) return;
    this.opened = true;
    const handlers = this.openHandlers;
    this.openHandlers = [];
    handlers.forEach((f) => f());
  }

  _closed() {
    if (this.closed) return;
    this.closed = true;
    this.closeHandlers.forEach((f) => f());
  }
}
