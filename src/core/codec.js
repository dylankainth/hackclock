// Squeeze a WebRTC data-channel SDP into a short string that fits a small,
// easy-to-scan QR code, and rebuild a valid SDP from it on the other side.
//
// A full browser SDP is ~600-900 bytes, most of it boilerplate that is the same
// for every data-channel-only session. Only four things are unique:
//   - ICE username fragment + password
//   - the DTLS certificate fingerprint (sha-256)
//   - the transport candidates (where to reach us)
//   - our DTLS role in an answer (active / passive)
//
// Format:   v1<kind><setup>~<ufrag>~<pwd>~<fingerprint b64url>~<cand>,<cand>...
//   kind    o = offer, a = answer
//   setup   X = actpass (offers), A = active, P = passive
//   cand    <h|s><addr>/<port>   addr starting with * is an mDNS uuid (b64url)

const SDP_EOL = '\r\n';

export class CodeError extends Error {}

// ---------- base64url + hex helpers ----------

function bytesToB64url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlToBytes(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function hexFingerprintToBytes(fp) {
  const parts = fp.split(':');
  return Uint8Array.from(parts.map((h) => parseInt(h, 16)));
}

function bytesToHexFingerprint(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0').toUpperCase()).join(':');
}

const MDNS_RE = /^([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})\.local$/i;

function mdnsToCompact(host) {
  const m = MDNS_RE.exec(host);
  if (!m) return null;
  const hex = m.slice(1).join('');
  const bytes = Uint8Array.from(hex.match(/../g).map((h) => parseInt(h, 16)));
  return '*' + bytesToB64url(bytes);
}

function compactToMdns(addr) {
  const hex = Array.from(b64urlToBytes(addr.slice(1)), (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}.local`;
}

// ---------- SDP parsing ----------

function isLoopback(addr) {
  return addr === '::1' || addr.startsWith('127.');
}

function isLinkLocal(addr) {
  return addr.toLowerCase().startsWith('fe80:') || addr.startsWith('169.254.');
}

function isIPv6(addr) {
  return addr.includes(':');
}

export function parseSdp(sdp, { allowLoopback = false, maxCandidates = 6 } = {}) {
  const lines = sdp.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const out = { ufrag: null, pwd: null, fingerprint: null, setup: null, mid: null, candidates: [] };

  for (const line of lines) {
    if (line.startsWith('a=ice-ufrag:')) out.ufrag = line.slice(12);
    else if (line.startsWith('a=ice-pwd:')) out.pwd = line.slice(10);
    else if (line.startsWith('a=fingerprint:')) {
      const [alg, value] = line.slice(14).split(' ');
      out.fingerprintAlg = alg.toLowerCase();
      out.fingerprint = value;
    } else if (line.startsWith('a=setup:')) out.setup = line.slice(8);
    else if (line.startsWith('a=mid:')) out.mid = line.slice(6);
    else if (line.startsWith('a=candidate:')) {
      // foundation component protocol priority address port typ type ...
      const f = line.slice(12).split(' ');
      if (f.length < 8 || f[6] !== 'typ') continue;
      const [, component, protocol, priority, addr, port, , type] = f;
      if (component !== '1' || protocol.toLowerCase() !== 'udp') continue;
      if (!allowLoopback && (isLoopback(addr) || isLinkLocal(addr))) continue;
      if (type !== 'host' && type !== 'srflx') continue;
      out.candidates.push({ type, addr, port: Number(port), priority: Number(priority) });
    }
  }

  if (!out.ufrag || !out.pwd || !out.fingerprint) {
    throw new CodeError('That connection info is incomplete (missing ICE or DTLS details).');
  }
  if (out.fingerprintAlg !== 'sha-256') {
    throw new CodeError(`Unsupported certificate fingerprint type: ${out.fingerprintAlg}`);
  }
  if (out.mid && out.mid !== '0') {
    throw new CodeError('Unexpected media section id in the connection info.');
  }

  // Keep the candidates most likely to work on a small LAN: IPv4 hosts first,
  // then mDNS names, then server-reflexive, then at most two IPv6 addresses.
  const rank = (c) => {
    if (c.type === 'host' && !isIPv6(c.addr) && !c.addr.endsWith('.local')) return 0;
    if (c.type === 'host' && c.addr.endsWith('.local')) return 1;
    if (c.type === 'srflx' && !isIPv6(c.addr)) return 2;
    return 3;
  };
  const sorted = [...out.candidates].sort((a, b) => rank(a) - rank(b) || b.priority - a.priority);
  const kept = [];
  let v6 = 0;
  for (const c of sorted) {
    if (isIPv6(c.addr) && ++v6 > 2) continue;
    if (kept.some((k) => k.addr === c.addr && k.port === c.port)) continue;
    kept.push(c);
    if (kept.length >= maxCandidates) break;
  }
  out.candidates = kept;
  return out;
}

// ---------- encode / decode ----------

const SETUP_TO_CHAR = { actpass: 'X', active: 'A', passive: 'P' };
const CHAR_TO_SETUP = { X: 'actpass', A: 'active', P: 'passive' };

export function encodeSignal(kind, sdp, opts) {
  if (kind !== 'o' && kind !== 'a') throw new CodeError('kind must be o or a');
  const p = parseSdp(sdp, opts);
  const setupChar = SETUP_TO_CHAR[p.setup] || (kind === 'o' ? 'X' : 'A');
  if (p.candidates.length === 0) {
    throw new CodeError(
      'No usable network address was found. Connect both devices to the same network or hotspot and try again.',
    );
  }
  const cands = p.candidates.map((c) => {
    const t = c.type === 'srflx' ? 's' : 'h';
    const addr = mdnsToCompact(c.addr) || c.addr;
    return `${t}${addr}/${c.port}`;
  });
  return ['v1' + kind + setupChar, p.ufrag, p.pwd, bytesToB64url(hexFingerprintToBytes(p.fingerprint)), cands.join(',')].join('~');
}

export function decodeSignal(code) {
  const text = String(code || '').trim();
  const parts = text.split('~');
  if (parts.length !== 5 || !/^v1[oa][XAP]$/.test(parts[0])) {
    throw new CodeError('That is not a Hackclock pairing code.');
  }
  const [head, ufrag, pwd, fp, candStr] = parts;
  let fingerprint;
  try {
    fingerprint = bytesToHexFingerprint(b64urlToBytes(fp));
  } catch {
    throw new CodeError('The pairing code is damaged (bad fingerprint).');
  }
  if (fingerprint.split(':').length !== 32) throw new CodeError('The pairing code is damaged (bad fingerprint).');

  const candidates = candStr
    .split(',')
    .filter(Boolean)
    .map((c, i) => {
      const type = c[0] === 's' ? 'srflx' : 'host';
      const slash = c.lastIndexOf('/');
      const rawAddr = c.slice(1, slash);
      const port = Number(c.slice(slash + 1));
      if (slash < 2 || !Number.isInteger(port) || port < 1 || port > 65535) {
        throw new CodeError('The pairing code is damaged (bad address).');
      }
      const addr = rawAddr.startsWith('*') ? compactToMdns(rawAddr) : rawAddr;
      return { type, addr, port, index: i };
    });
  if (!candidates.length) throw new CodeError('The pairing code has no network addresses.');

  return { kind: head[2], setup: CHAR_TO_SETUP[head[3]], ufrag, pwd, fingerprint, candidates };
}

export function buildSdp(decoded) {
  const { kind, setup, ufrag, pwd, fingerprint, candidates } = decoded;
  const lines = [
    'v=0',
    'o=- 4611731400430051336 2 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'a=group:BUNDLE 0',
    'a=msid-semantic: WMS',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'c=IN IP4 0.0.0.0',
    `a=ice-ufrag:${ufrag}`,
    `a=ice-pwd:${pwd}`,
    `a=fingerprint:sha-256 ${fingerprint}`,
    `a=setup:${setup}`,
    'a=mid:0',
    'a=sctp-port:5000',
    'a=max-message-size:262144',
  ];
  candidates.forEach((c, i) => {
    const typePref = c.type === 'host' ? 126 : 100;
    const priority = typePref * 16777216 + (65535 - i * 256) * 256 + 255;
    let line = `a=candidate:${i + 1} 1 udp ${priority} ${c.addr} ${c.port} typ ${c.type}`;
    if (c.type === 'srflx') line += ' raddr 0.0.0.0 rport 0';
    lines.push(line);
  });
  lines.push('a=end-of-candidates');
  return { type: kind === 'o' ? 'offer' : 'answer', sdp: lines.join(SDP_EOL) + SDP_EOL };
}

export function signalToDescription(code) {
  return buildSdp(decodeSignal(code));
}

// ---------- share links ----------

const HASH_KEY = 'p=';

export function codeToUrl(code, base) {
  return `${base}#${HASH_KEY}${code}`;
}

// Accepts a bare code, or a full URL / hash containing one.
export function extractCode(text) {
  const t = String(text || '').trim();
  const i = t.indexOf(HASH_KEY + 'v1');
  let code = i >= 0 ? t.slice(i + HASH_KEY.length) : t;
  try {
    if (code.includes('%')) code = decodeURIComponent(code);
  } catch {
    /* keep raw */
  }
  return code.replace(/\s+/g, '');
}
