# Hackclock

A countdown you run on your laptop and show on your phone, with **no server**.
The laptop is the controller (create timers, start, pause, nudge). The phone is a
display you prop up facing the presenters: huge digits that turn amber, then red,
then count overtime.

The two devices talk directly over a WebRTC data channel. You pair them once by
scanning a QR code each way, and after that nothing leaves your local network.

```
 laptop (controller)                                   phone (display)
 ───────────────────                                   ───────────────
 1. Pair a display  ──── offer QR (or link) ────────▶  scan it
                                                       2. phone shows its answer QR
 3. laptop webcam   ◀──── answer QR ─────────────────  hold up to webcam
 4. ◀════════════ WebRTC data channel, LAN only ════════════▶
    timeline: { endsAt, status, … } + clock-offset pings
```

## Use it

1. **Host `dist/` somewhere with HTTPS** (GitHub Pages, Cloudflare Pages, Netlify
   drop, anything static). The camera, screen wake lock and "install to home
   screen" all need HTTPS. It is a single self-contained `index.html` plus a
   service worker, manifest and icons.
2. **Open it once on each device while you have internet.** The service worker
   caches the app, so after that it loads with no network at all.
3. Turn on the **phone's hotspot** and join the laptop to it. (Venue Wi-Fi often
   blocks device-to-device traffic; a hotspot never does.)
4. Laptop: **Run the clock on this laptop**, then **Pair a display**. Allow the
   camera when asked.
5. Phone: scan the QR with its camera app (opens Hackclock and starts pairing), or
   open Hackclock, choose **Show the clock on this phone**, and scan in the app.
6. The phone now shows its own QR. Hold it up to the laptop's webcam. Done: the
   dialog closes and the phone goes live.

You can pair more than one display. If a camera is not an option, both sides have
**Copy code** and a paste box instead.

### Keyboard (laptop)

| Key | Action |
| --- | --- |
| `Space` | Start / pause / resume |
| `R` | Reset |
| `←` `→` | Previous / next timer |
| `↑` `↓` | +10 s / −10 s |

On the phone, tap the screen to show or hide the controls. **Rotate** turns the
clock a quarter turn so a portrait phone can use its long edge.

### Local development

```sh
npm install
npm run build        # -> dist/
npm run serve        # http://localhost:8080 (camera needs https, so use a host for real use)
```

## How it works

- **Sync a timeline, not ticks.** The controller sends `{status, endsAt,
  remainingMs, …}` whenever something changes. Each screen derives the digits
  locally every frame, so there is nothing to drift and nothing to stream.
- **Clock offset.** The phone pings the controller (NTP style: send time, the
  controller's stamp, receive time) and keeps the lowest-round-trip sample from a
  sliding window. In testing, a phone clock 42 s out was corrected to under 1 ms
  on loopback.
- **Single writer, so no CRDT needed.** The controller owns the state; a snapshot
  with a higher version replaces the old one. If you later want several judges
  controlling one clock, the `Link`/`Hub` layer in `src/core` is transport-only, so
  a Yjs or Automerge document can ride the same channel.
- **Pairing without a signalling server.** A browser SDP is ~700 bytes of mostly
  boilerplate. `src/core/codec.js` keeps only the ICE credentials, DTLS fingerprint
  and a few candidates (~95 characters) and rebuilds a valid SDP on the other side,
  so the QR codes are small and easy to scan.
- **Resilience.** If the link drops, the phone keeps counting from the last
  timeline and shows "Offline, still counting". The controller saves timers and the
  running clock to `localStorage`, so a reload does not lose them (the displays
  need re-pairing, since a WebRTC connection cannot survive a reload).
- **Phone stays awake** via the Screen Wake Lock API while it is a display.

## Network notes

- LAN only by default: no STUN or TURN, nothing third-party. Add `?stun` to the
  URL to try a public STUN server if you need to pair across networks.
- Allow the **laptop's camera**. Browsers hide local IP addresses behind mDNS
  names unless the camera is allowed, and those names do not always resolve between
  devices. Hackclock opens the camera before it builds the pairing code so the
  code carries a real address.
- Client isolation on venue Wi-Fi blocks this. Use the hotspot.

## Tests

```sh
npm test               # unit tests + a real WebRTC pairing between two Node peers
npm run test:e2e       # real Chromium, two isolated profiles, QR scanning via a fake camera
npm run test:offline   # service worker: shut the server down, the app still runs
```

The browser tests use `@sparticuz/chromium` (a Chromium binary distributed on npm)
so they run without a separate browser install. They write screenshots to
`test/shots/`.

### What has and has not been verified

Verified in automated tests: pairing in both directions by scanning QR codes,
pairing by link and by pasted code, a 37 s phone clock skew, pause / resume /
nudge / reset / next, adding timers, the colour phases, rotate, reload
persistence, offline countdown, error messages, and loading with no server.

**Not** verified, because it needs real devices: iOS Safari and Android Chrome
behaviour (WebRTC on a real hotspot, camera scanning at real distance, wake lock),
and the case where both sides only have mDNS candidates. Do a 2-minute dry run on
your own phone and hotspot before the event.

## Project layout

```
src/core/     timer model, clock sync, SDP codec, WebRTC pairing, hub/display session
src/ui/       seven-segment face, QR render + scanner
src/app.js    wires it together        src/styles.css, src/index.html
build.mjs     bundles to dist/ (one HTML file, fonts and JS inlined)
test/         unit, WebRTC, browser and offline tests
```
