// A seven-segment scoreboard display drawn as SVG. No fonts, so it looks the
// same on every device, never jitters, and unlit segments show faintly behind
// the lit ones like a real shot clock.

const NS = 'http://www.w3.org/2000/svg';

// Cell metrics (SVG units). A digit cell is 56 x 96.
const DIGIT_W = 56;
const SIGN_W = 42;
const COLON_W = 22;
const GAP = 10;
const HEIGHT = 96;
const SKEW_DEG = 6;
const SKEW_PAD = Math.ceil(Math.tan((SKEW_DEG * Math.PI) / 180) * HEIGHT);

const hex = (x1, y, x2) =>
  [[x1, y], [x1 + 5, y - 5], [x2 - 5, y - 5], [x2, y], [x2 - 5, y + 5], [x1 + 5, y + 5]];
const vhex = (x, y1, y2) =>
  [[x, y1], [x + 5, y1 + 5], [x + 5, y2 - 5], [x, y2], [x - 5, y2 - 5], [x - 5, y1 + 5]];
const pts = (list) => list.map((p) => p.join(',')).join(' ');

const SEGMENTS = {
  a: pts(hex(8, 5, 48)),
  b: pts(vhex(51, 8, 45)),
  c: pts(vhex(51, 51, 88)),
  d: pts(hex(8, 91, 48)),
  e: pts(vhex(5, 51, 88)),
  f: pts(vhex(5, 8, 45)),
  g: pts(hex(8, 48, 48)),
};

const DIGIT_SEGMENTS = {
  0: 'abcdef',
  1: 'bc',
  2: 'abdeg',
  3: 'abcdg',
  4: 'bcfg',
  5: 'acdfg',
  6: 'acdefg',
  7: 'abc',
  8: 'abcdefg',
  9: 'abcdfg',
};

// A layout is { hours, minDigits, sign }: only the cells that are needed right
// now, so the digits stay as large as the screen allows. The face rebuilds it when
// it changes (overtime starting, minutes reaching two digits), which is rare.
function cellKinds({ hours, minDigits, sign }) {
  const kinds = sign ? ['sign'] : [];
  if (hours) return kinds.concat(['d', 'colon', 'd', 'd', 'colon', 'd', 'd']);
  return kinds.concat(minDigits === 2 ? ['d', 'd'] : ['d'], ['colon', 'd', 'd']);
}

const layoutKey = (l) => `${l.hours ? 'h' : 'm'}${l.minDigits}${l.sign ? '+' : ''}`;

function node(name, attrs) {
  const n = document.createElementNS(NS, name);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  return n;
}

function rect(x, y, w, h) {
  return pts([[x, y], [x + w, y], [x + w, y + h], [x, y + h]]);
}

export class SegmentClock {
  constructor(svg) {
    this.svg = svg;
    this.layoutName = null;
    this.layout = null;
    this.cells = [];
    this.setLayout({ hours: false, minDigits: 1, sign: false });
  }

  setLayout(layout) {
    const key = layoutKey(layout);
    if (key === this.layoutName) return;
    this.layoutName = key;
    this.layout = layout;
    this.cells = [];
    const kinds = cellKinds(layout);
    const g = node('g', {});
    let x = 0;
    for (const kind of kinds) {
      const cell = { kind, last: undefined, segs: {} };
      const holder = node('g', { transform: `translate(${x},0)` });
      if (kind === 'd') {
        for (const s in SEGMENTS) {
          cell.segs[s] = node('polygon', { points: SEGMENTS[s], class: 'seg' });
          holder.appendChild(cell.segs[s]);
        }
        x += DIGIT_W + GAP;
      } else if (kind === 'colon') {
        for (const y of [27, 63]) holder.appendChild(node('polygon', { points: rect(6, y, 10, 10), class: 'seg on' }));
        x += COLON_W + GAP;
      } else {
        // sign: a plus
        cell.segs.h = node('polygon', { points: rect(5, 43, 32, 10), class: 'seg' });
        cell.segs.v = node('polygon', { points: rect(16, 27, 10, 42), class: 'seg' });
        holder.appendChild(cell.segs.h);
        holder.appendChild(cell.segs.v);
        x += SIGN_W + GAP;
      }
      g.appendChild(holder);
      this.cells.push(cell);
    }
    const width = x - GAP;
    const skewed = node('g', { transform: `translate(${SKEW_PAD},0) skewX(-${SKEW_DEG})` });
    skewed.appendChild(g);
    this.svg.replaceChildren(skewed);
    this.svg.setAttribute('viewBox', `0 0 ${width + SKEW_PAD} ${HEIGHT}`);
    this.svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  }

  // values: { plus: bool, digits: (0-9 | null)[] } with one entry per digit cell.
  render({ plus, digits }) {
    let di = 0;
    for (const cell of this.cells) {
      if (cell.kind === 'sign') {
        const on = !!plus;
        if (cell.last !== on) {
          cell.last = on;
          cell.segs.h.classList.toggle('on', on);
          cell.segs.v.classList.toggle('on', on);
        }
      } else if (cell.kind === 'd') {
        const v = digits[di++];
        if (cell.last !== v) {
          cell.last = v;
          const lit = v == null ? '' : DIGIT_SEGMENTS[v];
          for (const s in cell.segs) cell.segs[s].classList.toggle('on', lit.includes(s));
        }
      }
    }
  }
}

// Decide which cells the face needs for this slot length and this moment.
export function layoutFor(durationMs, parts) {
  const hours = durationMs >= 3600 * 1000 || parts.h > 0;
  const needed = Math.max(Math.floor(durationMs / 60000), parts.h * 60 + parts.m);
  return { hours, minDigits: hours || needed >= 10 ? 2 : 1, sign: parts.plus };
}

// Turn clockParts() into one value per digit cell, blanking a leading minutes
// zero the way a scoreboard does.
export function digitsFor(layout, parts) {
  const sec10 = Math.floor(parts.s / 10);
  const sec1 = parts.s % 10;
  if (layout.hours) {
    return [Math.min(parts.h, 9), Math.floor(parts.m / 10), parts.m % 10, sec10, sec1];
  }
  const minutes = Math.min(parts.h * 60 + parts.m, 99);
  const tail = [minutes % 10, sec10, sec1];
  return layout.minDigits === 2 ? [minutes >= 10 ? Math.floor(minutes / 10) : null, ...tail] : tail;
}
