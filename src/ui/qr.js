// QR rendering and scanning.

import qrcode from 'qrcode-generator';
import jsQR from 'jsqr';

// Returns SVG markup: dark modules on a white card with a 4-module quiet zone.
export function qrSvg(text, { ecc = 'M', margin = 4 } = {}) {
  const qr = qrcode(0, ecc);
  qr.addData(text, 'Byte');
  qr.make();
  const n = qr.getModuleCount();
  const size = n + margin * 2;
  let d = '';
  for (let r = 0; r < n; r++) {
    let c = 0;
    while (c < n) {
      if (!qr.isDark(r, c)) {
        c++;
        continue;
      }
      let run = 1;
      while (c + run < n && qr.isDark(r, c + run)) run++;
      d += `M${c + margin} ${r + margin}h${run}v1h-${run}z`;
      c += run;
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="QR code">` +
    `<rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#0b1626"/></svg>`
  );
}

export function qrVersionInfo(text, ecc = 'M') {
  const qr = qrcode(0, ecc);
  qr.addData(text, 'Byte');
  qr.make();
  return { modules: qr.getModuleCount(), bytes: new TextEncoder().encode(text).length };
}

// ---------- camera ----------

export function cameraSupported() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
}

export async function openCamera(facing = 'environment') {
  if (!cameraSupported()) throw new Error('This browser cannot open the camera here. Camera access needs a secure (https) page.');
  try {
    return await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: facing }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
  } catch (e) {
    if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) {
      throw new Error('Camera blocked. Allow camera access for this page, or paste the code instead.');
    }
    if (e && e.name === 'NotFoundError') throw new Error('No camera found. Paste the code instead.');
    throw new Error('Could not start the camera. Paste the code instead.');
  }
}

export function stopStream(stream) {
  if (stream) stream.getTracks().forEach((t) => t.stop());
}

// Watches a stream for QR codes. `onText` returns true once it has accepted a
// code (scanning then stops). Returns a stop function; the stream stays open.
export async function scanStream(video, stream, onText) {
  video.setAttribute('playsinline', '');
  video.muted = true;
  video.srcObject = stream;
  try {
    await video.play();
  } catch {
    /* autoplay quirks: frames still arrive once visible */
  }

  let detector = null;
  if ('BarcodeDetector' in window) {
    try {
      const formats = await window.BarcodeDetector.getSupportedFormats();
      if (formats.includes('qr_code')) detector = new window.BarcodeDetector({ formats: ['qr_code'] });
    } catch {
      detector = null;
    }
  }

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  let stopped = false;
  let timer = null;

  const tick = async () => {
    if (stopped) return;
    if (video.readyState >= 2 && video.videoWidth) {
      try {
        let text = null;
        if (detector) {
          const found = await detector.detect(video);
          if (found.length) text = found[0].rawValue;
        } else if (ctx) {
          const scale = Math.min(1, 800 / video.videoWidth);
          canvas.width = Math.round(video.videoWidth * scale);
          canvas.height = Math.round(video.videoHeight * scale);
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const hit = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
          if (hit) text = hit.data;
        }
        if (text && onText(text) === true) {
          stopped = true;
          return;
        }
      } catch {
        /* a bad frame is not fatal */
      }
    }
    timer = setTimeout(tick, 110);
  };
  tick();

  return () => {
    stopped = true;
    clearTimeout(timer);
    video.srcObject = null;
  };
}
