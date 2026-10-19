import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CodeError, parseSdp, encodeSignal, decodeSignal, buildSdp, signalToDescription, codeToUrl, extractCode,
} from '../src/core/codec.js';

const FP = '3B:5F:0C:9A:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:12:34:56:78:9A:BC:DE:F0:0F:1E:2D:3C';

// Shaped like a real Chrome data-channel-only offer, with mDNS host candidates.
const chromeOffer = [
  'v=0',
  'o=- 8472650185049310001 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'a=group:BUNDLE 0',
  'a=extmap-allow-mixed',
  'a=msid-semantic: WMS',
  'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
  'c=IN IP4 0.0.0.0',
  'a=candidate:1111 1 udp 2113937151 6f1c9d3e-1a2b-4c3d-8e4f-5a6b7c8d9e0f.local 54321 typ host generation 0 network-cost 999',
  'a=candidate:2222 1 udp 2113939711 1b2c3d4e-5f60-4a71-8b92-a3b4c5d6e7f8.local 40001 typ host generation 0 network-cost 999',
  'a=candidate:3333 1 tcp 1518280447 6f1c9d3e-1a2b-4c3d-8e4f-5a6b7c8d9e0f.local 9 typ host tcptype active generation 0',
  'a=ice-ufrag:aB3d',
  'a=ice-pwd:Zk9+Xq2/LmN4pQrStUvWxYz1',
  'a=ice-options:trickle',
  `a=fingerprint:sha-256 ${FP}`,
  'a=setup:actpass',
  'a=mid:0',
  'a=sctp-port:5000',
  'a=max-message-size:262144',
  '',
].join('\r\n');

// Shaped like a Firefox answer: raw IPs, IPv6, link-local, loopback, hex ufrag.
const firefoxAnswer = [
  'v=0',
  'o=mozilla...THIS_IS_SDPARTA-99.0 1234567890123456789 0 IN IP4 0.0.0.0',
  's=-',
  't=0 0',
  `a=fingerprint:sha-256 ${FP}`,
  'a=group:BUNDLE 0',
  'a=ice-options:trickle',
  'a=msid-semantic:WMS *',
  'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
  'c=IN IP4 0.0.0.0',
  'a=candidate:0 1 UDP 2122252543 172.20.10.4 51234 typ host',
  'a=candidate:1 1 UDP 2122187007 2a00:23c8:1234:5678:aaaa:bbbb:cccc:dddd 51235 typ host',
  'a=candidate:2 1 UDP 2122121471 2a00:23c8:1234:5678:1111:2222:3333:4444 51236 typ host',
  'a=candidate:3 1 UDP 2122055935 2a00:23c8:1234:5678:5555:6666:7777:8888 51237 typ host',
  'a=candidate:4 1 UDP 2122000000 fe80::1c2d:3e4f:5a6b:7c8d 51238 typ host',
  'a=candidate:5 1 UDP 2122000001 127.0.0.1 51239 typ host',
  'a=candidate:6 1 UDP 1686052607 81.2.69.142 51234 typ srflx raddr 172.20.10.4 rport 51234',
  'a=sendrecv',
  'a=end-of-candidates',
  'a=ice-pwd:0123456789abcdef0123456789abcdef',
  'a=ice-ufrag:9f8e7d6c',
  'a=mid:0',
  'a=setup:active',
  'a=sctp-port:5000',
  'a=max-message-size:1073741823',
  '',
].join('\r\n');

test('parses ICE, DTLS and usable candidates out of a Chrome offer', () => {
  const p = parseSdp(chromeOffer);
  assert.equal(p.ufrag, 'aB3d');
  assert.equal(p.pwd, 'Zk9+Xq2/LmN4pQrStUvWxYz1');
  assert.equal(p.fingerprint, FP);
  assert.equal(p.setup, 'actpass');
  assert.equal(p.candidates.length, 2, 'tcp candidate is dropped');
});

test('drops loopback and link-local, caps IPv6 at two, keeps IPv4 first', () => {
  const p = parseSdp(firefoxAnswer);
  const addrs = p.candidates.map((c) => c.addr);
  assert.equal(addrs[0], '172.20.10.4');
  assert.ok(!addrs.includes('127.0.0.1'));
  assert.ok(!addrs.some((a) => a.startsWith('fe80')));
  assert.equal(addrs.filter((a) => a.includes(':')).length, 2);
  assert.ok(addrs.includes('81.2.69.142'));
});

test('offer round-trips through the code', () => {
  const code = encodeSignal('o', chromeOffer);
  assert.match(code, /^v1oX~aB3d~/);
  const d = decodeSignal(code);
  assert.equal(d.kind, 'o');
  assert.equal(d.setup, 'actpass');
  assert.equal(d.ufrag, 'aB3d');
  assert.equal(d.pwd, 'Zk9+Xq2/LmN4pQrStUvWxYz1');
  assert.equal(d.fingerprint, FP);
  // Highest-priority candidate comes first (the 40001 one has the higher priority).
  assert.deepEqual(
    d.candidates.map((c) => [c.addr, c.port]),
    [
      ['1b2c3d4e-5f60-4a71-8b92-a3b4c5d6e7f8.local', 40001],
      ['6f1c9d3e-1a2b-4c3d-8e4f-5a6b7c8d9e0f.local', 54321],
    ],
  );
});

test('answer keeps the DTLS role it chose', () => {
  const code = encodeSignal('a', firefoxAnswer);
  assert.match(code, /^v1aA~/);
  assert.equal(decodeSignal(code).setup, 'active');
  const passive = firefoxAnswer.replace('a=setup:active', 'a=setup:passive');
  assert.match(encodeSignal('a', passive), /^v1aP~/);
});

test('rebuilt SDP is a well-formed data-channel description', () => {
  const { type, sdp } = signalToDescription(encodeSignal('o', chromeOffer));
  assert.equal(type, 'offer');
  assert.match(sdp, /^v=0\r\n/);
  assert.match(sdp, /m=application 9 UDP\/DTLS\/SCTP webrtc-datachannel\r\n/);
  assert.match(sdp, /a=ice-ufrag:aB3d\r\n/);
  assert.match(sdp, new RegExp(`a=fingerprint:sha-256 ${FP}\\r\\n`));
  assert.match(sdp, /a=setup:actpass\r\n/);
  assert.match(sdp, /a=candidate:1 1 udp \d+ 1b2c3d4e-5f60-4a71-8b92-a3b4c5d6e7f8\.local 40001 typ host\r\n/);
  assert.match(sdp, /a=candidate:2 1 udp \d+ 6f1c9d3e-1a2b-4c3d-8e4f-5a6b7c8d9e0f\.local 54321 typ host\r\n/);
  assert.ok(sdp.endsWith('a=end-of-candidates\r\n'));

  const ans = signalToDescription(encodeSignal('a', firefoxAnswer));
  assert.equal(ans.type, 'answer');
  assert.match(ans.sdp, /raddr 0\.0\.0\.0 rport 0/, 'srflx gets a placeholder raddr');
});

test('synthesised priorities keep host order and stay in the valid 31-bit range', () => {
  const { sdp } = signalToDescription(encodeSignal('a', firefoxAnswer));
  const hosts = [...sdp.matchAll(/a=candidate:\d+ 1 udp (\d+) \S+ \d+ typ host/g)].map((m) => Number(m[1]));
  assert.ok(hosts.length >= 2);
  for (let i = 1; i < hosts.length; i++) assert.ok(hosts[i] < hosts[i - 1], 'host priorities strictly decrease');
  const all = [...sdp.matchAll(/a=candidate:\d+ 1 udp (\d+) /g)].map((m) => Number(m[1]));
  assert.ok(all.every((p) => p > 0 && p < 2 ** 31));
});

test('codes are small enough for an easy-to-scan QR', () => {
  assert.ok(encodeSignal('o', chromeOffer).length < 220, 'chrome offer');
  assert.ok(encodeSignal('a', firefoxAnswer).length < 260, 'firefox answer');
});

test('rejects garbage with a readable error', () => {
  for (const bad of ['', 'hello', 'v1oX~a~b', 'v2oX~a~b~c~d', 'v1oX~a~b~!!!~h1.2.3.4/80']) {
    assert.throws(() => decodeSignal(bad), CodeError, bad);
  }
  assert.throws(() => decodeSignal('v1oX~u~p~AAAA~h1.2.3.4/80'), /fingerprint/);
  const fp = encodeSignal('o', chromeOffer).split('~')[3];
  assert.throws(() => decodeSignal(`v1oX~u~p~${fp}~h1.2.3.4/notaport`), /address/);
  assert.throws(() => decodeSignal(`v1oX~u~p~${fp}~`), /no network addresses/);
});

test('refuses an SDP with nothing to connect to', () => {
  const none = chromeOffer.split('\r\n').filter((l) => !l.startsWith('a=candidate')).join('\r\n');
  assert.throws(() => encodeSignal('o', none), /No usable network address/);
});

test('refuses non sha-256 fingerprints and missing fields', () => {
  assert.throws(() => parseSdp(chromeOffer.replace('sha-256', 'sha-1')), /Unsupported/);
  assert.throws(() => parseSdp(chromeOffer.replace(/a=ice-pwd.*\r\n/, '')), /incomplete/);
});

test('share links: url round trip, bare code, percent-encoded', () => {
  const code = encodeSignal('o', chromeOffer);
  const url = codeToUrl(code, 'https://example.github.io/hackclock/');
  assert.equal(extractCode(url), code);
  assert.equal(extractCode(code), code);
  assert.equal(extractCode(`  ${code}\n`), code);
  assert.equal(extractCode(`https://x.y/#p=${encodeURIComponent(code)}`), code);
  assert.equal(extractCode('#p=' + code), code);
});

test('mDNS uuid compaction is lossless for any uuid', () => {
  for (const id of ['00000000-0000-0000-0000-000000000000', 'ffffffff-ffff-ffff-ffff-ffffffffffff', 'a1b2c3d4-e5f6-4789-abcd-ef0123456789']) {
    const sdp = chromeOffer.replace(/[0-9a-f-]{36}\.local 54321/, `${id}.local 54321`);
    const d = decodeSignal(encodeSignal('o', sdp));
    assert.ok(d.candidates.some((c) => c.addr === `${id}.local`), id);
  }
});

test('buildSdp is deterministic', () => {
  const d = decodeSignal(encodeSignal('o', chromeOffer));
  assert.equal(buildSdp(d).sdp, buildSdp(d).sdp);
});
