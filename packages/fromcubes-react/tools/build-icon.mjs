/**
 * Build nodes/icons/fromcubes-react.svg — the fromcubes mark with a React-ish
 * badge, same construction as the fromcubes-db icon: the mark is traced from
 * the project artwork, and the badge is cut out of it with a mask rather than
 * hidden behind a halo painted in the background colour, because an icon cannot
 * know what is behind it on the canvas.
 *
 * The badge is Lucide's "atom" (ISC — see THIRD-PARTY-NOTICES.md), not React's
 * own logo, which is a Meta trademark.
 *
 * Run: node tools/build-icon.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { decodePng, toMask, downsample, traceContours, simplify, encodePng } from './png-trace.mjs';
import { ICONS } from './lucide-icons.mjs';

// ---- trace the mark ----
const png = decodePng(readFileSync(new URL('fromcubes-mark.png', import.meta.url)));
const mask = toMask(png);
let minX = 1e9,
  minY = 1e9,
  maxX = -1,
  maxY = -1;
for (let y = 0; y < png.height; y++)
  for (let x = 0; x < png.width; x++)
    if (mask[y * png.width + x]) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
const side = Math.max(maxX - minX + 1, maxY - minY + 1);
const ox = Math.round((minX + maxX) / 2 - side / 2),
  oy = Math.round((minY + maxY) / 2 - side / 2);
const crop = new Uint8Array(side * side);
for (let y = 0; y < side; y++)
  for (let x = 0; x < side; x++) {
    const sx = ox + x,
      sy = oy + y;
    crop[y * side + x] =
      sx >= 0 && sy >= 0 && sx < png.width && sy < png.height ? mask[sy * png.width + sx] : 0;
  }

const loops0 = traceContours(downsample(crop, side, side, 192), 192, 192)
  .map((l) => simplify(l, 1.2))
  .filter((l) => l.length > 2);
let ax = 1e9,
  ay = 1e9,
  bx = -1e9,
  by = -1e9;
for (const l of loops0)
  for (const [x, y] of l) {
    if (x < ax) ax = x;
    if (x > bx) bx = x;
    if (y < ay) ay = y;
    if (y > by) by = y;
  }
const w = bx - ax,
  h = by - ay;

// ---- mark on its own, for the editor chrome ----
// The React Editor's header wants the bare mark, not the badged node icon, and
// wants it to follow the surrounding text colour on both a light footer and a
// dark overlay — hence currentColor and a tight box of its own.
{
  const BOX = 64,
    PAD = 1;
  const ms = (BOX - PAD * 2) / Math.max(w, h);
  const dx = (BOX - w * ms) / 2,
    dy = (BOX - h * ms) / 2;
  const d = loops0
    .map(
      (l) =>
        'M' +
        l
          .map(([x, y]) => `${(dx + (x - ax) * ms).toFixed(2)} ${(dy + (y - ay) * ms).toFixed(2)}`)
          .join('L') +
        'Z',
    )
    .join('');
  writeFileSync(
    new URL('../nodes/editor/mark.svg', import.meta.url),
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${BOX} ${BOX}" width="${BOX}" height="${BOX}">
  <!-- The fromcubes mark, traced from the project artwork by tools/build-icon.mjs.
       currentColor so the editor chrome can recolour it per surface. -->
  <path fill="currentColor" fill-rule="evenodd" d="${d}"/>
</svg>
`,
  );
  console.log('mark.svg written');
}

// ---- layout ----
// Node-RED renders icons in a 40x60 window; 44 wide buys room for the badge at
// a negligible cost in rendered size. Constants match the fromcubes-db icon so
// the two nodes read as one family on a canvas that holds both.
const CW = 44,
  CH = 60;
const CUBE = 39,
  CX = 21.4,
  CY = 25.75;
const s = CUBE / Math.max(w, h);
const cube = loops0.map((l) =>
  l.map(([x, y]) => [CX + (x - ax - w / 2) * s, CY + (y - ay - h / 2) * s]),
);

// Badge: down and to the right, so the pair reads on the diagonal.
const SW = 2.4;
const KNOCK = SW + 3.0;
// Every Lucide icon pads its 24x24 box differently, so a shared scale would
// make one badge tower over the next. Each is fitted to the same target square
// instead: same visual weight, same place, whatever the source padding.
const BADGE_SIDE = 15.8,
  BADGE_CX = 34.7,
  BADGE_CY = 43.75;
/** current badge transform, set per variant by {@link fitBadge} */
let BS = 1,
  BX = 0,
  BY = 0;

// One badge per node type, so the three fromcubes nodes stay apart on a canvas
// while sharing the mark. Path data is shared with the editor's file-tree
// sprite (tools/lucide-icons.mjs) — the same shape means the same thing in
// both places, and it can only stay that way if there is one copy of it.
const VARIANTS = [
  { file: 'fromcubes-react.svg', icon: 'atom', for: 'portal-react' },
  { file: 'fromcubes-component.svg', icon: 'component', for: 'fc-portal-component' },
  { file: 'fromcubes-utility.svg', icon: 'wrench', for: 'fc-portal-utility' },
].map((v) => ({
  ...v,
  lucide: ICONS[v.icon].lucide,
  badge: ICONS[v.icon].body
    .split('\n')
    .map((l) => '    ' + l)
    .join('\n'),
}));

const P = (x, y) => [BX + x * BS, BY + y * BS];

/**
 * Choose the transform that drops one badge into the shared target square.
 * @param {string} markup
 * @returns {Array<Array<[number, number]>>} the badge, flattened in canvas units
 */
function fitBadge(markup) {
  BS = 1;
  BX = 0;
  BY = 0;
  const raw = badgeLoops(markup).flat();
  const box = raw.reduce(
    (b, [x, y]) => [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)],
    [1e9, 1e9, -1e9, -1e9],
  );
  const bw = box[2] - box[0],
    bh = box[3] - box[1];
  BS = BADGE_SIDE / Math.max(bw, bh);
  BX = BADGE_CX - (box[0] + bw / 2) * BS;
  BY = BADGE_CY - (box[1] + bh / 2) * BS;
  return badgeLoops(markup);
}

/**
 * Flatten SVG path data into canvas points. Covers what Lucide emits —
 * M/L/H/V/C/S/Q/T/A/Z in both cases — because the badges are taken as-is and
 * the preview must show what actually ships, not an approximation of it.
 *
 * @param {string} d
 * @param {number} [steps] samples per curve segment
 * @returns {Array<[number, number]>}
 */
function flattenPath(d, steps = 16) {
  const out = [];
  let x = 0,
    y = 0,
    sx = 0,
    sy = 0,
    px = 0,
    py = 0,
    prev = '';
  const cubic = (x1, y1, x2, y2, x3, y3) => {
    for (let i = 1; i <= steps; i++) {
      const t = i / steps,
        u = 1 - t;
      out.push(
        P(
          u ** 3 * x + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t ** 3 * x3,
          u ** 3 * y + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t ** 3 * y3,
        ),
      );
    }
    px = x2;
    py = y2;
    x = x3;
    y = y3;
  };
  const arc = (rx, ry, rot, large, sweep, ex, ey) => {
    // Endpoint → centre parameterisation (SVG spec F.6.5).
    const phi = (rot * Math.PI) / 180,
      cos = Math.cos(phi),
      sin = Math.sin(phi);
    const dx2 = (x - ex) / 2,
      dy2 = (y - ey) / 2;
    const x1 = cos * dx2 + sin * dy2,
      y1 = -sin * dx2 + cos * dy2;
    let rx2 = Math.abs(rx),
      ry2 = Math.abs(ry);
    const lam = (x1 * x1) / (rx2 * rx2) + (y1 * y1) / (ry2 * ry2);
    if (lam > 1) {
      const k = Math.sqrt(lam);
      rx2 *= k;
      ry2 *= k;
    }
    const num = rx2 * rx2 * ry2 * ry2 - rx2 * rx2 * y1 * y1 - ry2 * ry2 * x1 * x1;
    const den = rx2 * rx2 * y1 * y1 + ry2 * ry2 * x1 * x1;
    let co = Math.sqrt(Math.max(0, num / den));
    if (large === sweep) co = -co;
    const cx1 = (co * rx2 * y1) / ry2,
      cy1 = (-co * ry2 * x1) / rx2;
    const cx = cos * cx1 - sin * cy1 + (x + ex) / 2,
      cy = sin * cx1 + cos * cy1 + (y + ey) / 2;
    const ang = (ux, uy, vx, vy) => {
      const dot = ux * vx + uy * vy,
        len = Math.hypot(ux, uy) * Math.hypot(vx, vy);
      let a = Math.acos(Math.min(1, Math.max(-1, dot / len)));
      if (ux * vy - uy * vx < 0) a = -a;
      return a;
    };
    const t1 = ang(1, 0, (x1 - cx1) / rx2, (y1 - cy1) / ry2);
    let dt = ang((x1 - cx1) / rx2, (y1 - cy1) / ry2, (-x1 - cx1) / rx2, (-y1 - cy1) / ry2);
    if (!sweep && dt > 0) dt -= 2 * Math.PI;
    if (sweep && dt < 0) dt += 2 * Math.PI;
    const n = Math.max(2, Math.ceil((Math.abs(dt) / Math.PI) * steps));
    for (let i = 1; i <= n; i++) {
      const t = t1 + (dt * i) / n;
      out.push(
        P(
          cx + rx2 * Math.cos(t) * cos - ry2 * Math.sin(t) * sin,
          cy + rx2 * Math.cos(t) * sin + ry2 * Math.sin(t) * cos,
        ),
      );
    }
    x = ex;
    y = ey;
  };

  for (const chunk of d.match(/[a-zA-Z][^a-zA-Z]*/g) || []) {
    const cmd = chunk[0];
    const a = (chunk.slice(1).match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi) || []).map(Number);
    const rel = cmd === cmd.toLowerCase();
    let i = 0;
    switch (cmd.toUpperCase()) {
      case 'M':
        x = rel ? x + a[0] : a[0];
        y = rel ? y + a[1] : a[1];
        sx = x;
        sy = y;
        out.push(P(x, y));
        for (i = 2; i + 1 < a.length; i += 2) {
          x = rel ? x + a[i] : a[i];
          y = rel ? y + a[i + 1] : a[i + 1];
          out.push(P(x, y));
        }
        break;
      case 'L':
        for (; i + 1 < a.length; i += 2) {
          x = rel ? x + a[i] : a[i];
          y = rel ? y + a[i + 1] : a[i + 1];
          out.push(P(x, y));
        }
        break;
      case 'H':
        for (; i < a.length; i++) {
          x = rel ? x + a[i] : a[i];
          out.push(P(x, y));
        }
        break;
      case 'V':
        for (; i < a.length; i++) {
          y = rel ? y + a[i] : a[i];
          out.push(P(x, y));
        }
        break;
      case 'C':
        for (; i + 5 < a.length; i += 6)
          cubic(
            rel ? x + a[i] : a[i],
            rel ? y + a[i + 1] : a[i + 1],
            rel ? x + a[i + 2] : a[i + 2],
            rel ? y + a[i + 3] : a[i + 3],
            rel ? x + a[i + 4] : a[i + 4],
            rel ? y + a[i + 5] : a[i + 5],
          );
        break;
      case 'S':
        for (; i + 3 < a.length; i += 4) {
          const rx = 'CS'.includes(prev.toUpperCase()) ? 2 * x - px : x;
          const ry = 'CS'.includes(prev.toUpperCase()) ? 2 * y - py : y;
          cubic(
            rx,
            ry,
            rel ? x + a[i] : a[i],
            rel ? y + a[i + 1] : a[i + 1],
            rel ? x + a[i + 2] : a[i + 2],
            rel ? y + a[i + 3] : a[i + 3],
          );
        }
        break;
      case 'Q':
      case 'T': {
        // Quadratics promoted to cubics; Lucide barely uses them, but a badge
        // that silently vanished from the preview would be worse.
        for (; i + (cmd.toUpperCase() === 'Q' ? 3 : 1) < a.length; i += cmd.toUpperCase() === 'Q' ? 4 : 2) {
          const qx = cmd.toUpperCase() === 'Q' ? (rel ? x + a[i] : a[i]) : 2 * x - px;
          const qy = cmd.toUpperCase() === 'Q' ? (rel ? y + a[i + 1] : a[i + 1]) : 2 * y - py;
          const ex = cmd.toUpperCase() === 'Q' ? (rel ? x + a[i + 2] : a[i + 2]) : rel ? x + a[i] : a[i];
          const ey =
            cmd.toUpperCase() === 'Q' ? (rel ? y + a[i + 3] : a[i + 3]) : rel ? y + a[i + 1] : a[i + 1];
          cubic(x + (2 / 3) * (qx - x), y + (2 / 3) * (qy - y), ex + (2 / 3) * (qx - ex), ey + (2 / 3) * (qy - ey), ex, ey);
        }
        break;
      }
      case 'A':
        for (; i + 6 < a.length; i += 7)
          arc(
            a[i],
            a[i + 1],
            a[i + 2],
            !!a[i + 3],
            !!a[i + 4],
            rel ? x + a[i + 5] : a[i + 5],
            rel ? y + a[i + 6] : a[i + 6],
          );
        break;
      case 'Z':
        x = sx;
        y = sy;
        out.push(P(x, y));
        break;
      default:
        break;
    }
    prev = cmd;
  }
  return out;
}

/**
 * Badge markup → flattened polylines, circles included.
 * @param {string} markup
 * @returns {Array<Array<[number, number]>>}
 */
function badgeLoops(markup) {
  const loops = (markup.match(/d="([^"]+)"/g) || []).map((m) => flattenPath(m.slice(3, -1)));
  for (const c of markup.match(/<circle[^/]*\/>/g) || []) {
    const at = (n) => Number((c.match(new RegExp(n + '="([^"]+)"')) || [])[1]);
    const cx = at('cx'),
      cy = at('cy'),
      r = at('r');
    loops.push(
      Array.from({ length: 33 }, (_, i) => {
        const a = (i / 32) * Math.PI * 2;
        return P(cx + r * Math.cos(a), cy + r * Math.sin(a));
      }),
    );
  }
  return loops;
}

// ---- one icon per node type ----
const MARK_FILL = '#10181d';
// React cyan darkened until it holds up on a white node body the way the
// fromcubes-db teal does; the bright #61dafb washes out at icon size. All three
// variants share it — the badge shape carries the difference, not the colour.
const BADGE_STROKE = '#0f6f8c';
const S = 8,
  W = CW * S,
  H = CH * S;
const hex = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
const [MR, MG, MB] = hex(MARK_FILL);
const [BR, BG, BB] = hex(BADGE_STROKE);

// The shipped path stays the crisp original trace; the cut-out is expressed as
// a mask, so no edge is ever rasterised and retraced.
const d = cube
  .map((l) => 'M' + l.map(([x, y]) => `${x.toFixed(2)} ${y.toFixed(2)}`).join('L') + 'Z')
  .join('');
console.log(
  'mark:',
  cube.length,
  'loops,',
  cube.reduce((n, l) => n + l.length, 0),
  'points,',
  d.length,
  'chars',
);

const gOpen = (stroke, width) =>
  `<g transform="translate(${BX} ${BY}) scale(${BS.toFixed(4)})" fill="none" stroke="${stroke}"\n     stroke-width="${(width / BS).toFixed(2)}" stroke-linecap="round" stroke-linejoin="round">`;

/**
 * Stamp a stroked polyline into a byte grid — used both to knock the badge out
 * of the mark and to paint it into the preview.
 * @param {Array<Array<[number, number]>>} loops
 * @param {number} width stroke width in canvas units
 * @param {(x: number, y: number) => void} plot
 * @returns {void}
 */
function strokeLoops(loops, width, plot) {
  for (const poly of loops)
    for (let i = 0; i + 1 < poly.length; i++) {
      const [x1, y1] = poly[i],
        [x2, y2] = poly[i + 1];
      const n = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1) * S)),
        r = (width * S) / 2;
      for (let t = 0; t <= n; t++) {
        const cx = (x1 + ((x2 - x1) * t) / n) * S,
          cy = (y1 + ((y2 - y1) * t) / n) * S;
        for (let y = Math.floor(cy - r); y <= cy + r; y++)
          for (let x = Math.floor(cx - r); x <= cx + r; x++) {
            if (x < 0 || y < 0 || x >= W || y >= H) continue;
            if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) plot(x, y);
          }
      }
    }
}

// The mark's fill, rasterised once — every variant knocks its own badge out of
// a copy of it.
const markGrid = new Uint8Array(W * H);
for (let y = 0; y < H; y++) {
  const sy = (y + 0.5) / S,
    xs = [];
  for (const poly of cube)
    for (let i = 0; i < poly.length; i++) {
      const [x1, y1] = poly[i],
        [x2, y2] = poly[(i + 1) % poly.length];
      if (y1 === y2) continue;
      if (sy >= Math.min(y1, y2) && sy < Math.max(y1, y2))
        xs.push(x1 + ((sy - y1) / (y2 - y1)) * (x2 - x1));
    }
  xs.sort((a, b) => a - b);
  for (let i = 0; i + 1 < xs.length; i += 2)
    for (
      let x = Math.max(0, Math.ceil(xs[i] * S - 0.5));
      x <= Math.min(W - 1, Math.floor(xs[i + 1] * S - 0.5));
      x++
    )
      markGrid[y * W + x] = 1;
}

const ext = (pts, pad = 0) =>
  pts.reduce(
    (b, [x, y]) => [
      Math.min(b[0], x - pad),
      Math.min(b[1], y - pad),
      Math.max(b[2], x + pad),
      Math.max(b[3], y + pad),
    ],
    [1e9, 1e9, -1e9, -1e9],
  );
const markExt = ext(cube.flat());

for (const variant of VARIANTS) {
  const loops = fitBadge(variant.badge);

  // What the drawing actually occupies, stroke included — the badge's outer
  // edge sits SW/2 beyond its path, so placing by path coordinates alone clips it.
  const b = ext(loops.flat(), SW / 2);
  console.log(
    variant.file.padEnd(24),
    'badge x',
    b[0].toFixed(1) + '..' + b[2].toFixed(1),
    ' y',
    b[1].toFixed(1) + '..' + b[3].toFixed(1),
    ' free r',
    (CW - Math.max(markExt[2], b[2])).toFixed(1),
    ' b',
    (CH - Math.max(markExt[3], b[3])).toFixed(1),
  );

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${CW}" height="${CH}" viewBox="0 0 ${CW} ${CH}">
  <!-- The fromcubes mark, traced from the project artwork by tools/build-icon.mjs.
       The badge is cut out of the mark with a mask rather than hidden behind a
       halo painted in the background colour: an icon cannot know what is behind
       it, and masking keeps the traced edges exact instead of re-rasterising them.
       The badge is the "${variant.lucide}" icon from Lucide (https://lucide.dev), ISC —
       see THIRD-PARTY-NOTICES.md. Worn by ${variant.for}. React's own logo is a
       Meta trademark and is deliberately not used. -->
  <mask id="fc-cut" maskUnits="userSpaceOnUse" x="0" y="0" width="${CW}" height="${CH}">
    <rect width="${CW}" height="${CH}" fill="#ffffff"/>
    ${gOpen('#000000', KNOCK)}
${variant.badge}
    </g>
  </mask>
  <path fill="${MARK_FILL}" fill-rule="evenodd" mask="url(#fc-cut)" d="${d}"/>
  ${gOpen(BADGE_STROKE, SW)}
${variant.badge}
  </g>
</svg>
`;
  writeFileSync(new URL('../nodes/icons/' + variant.file, import.meta.url), svg);

  // ---- preview on the node body and on white ----
  const grid = markGrid.slice();
  strokeLoops(loops, KNOCK, (x, y) => {
    grid[y * W + x] = 0;
  });
  for (const [bg, name] of [
    [[0xa8, 0xd8, 0xea], 'node'],
    [[0xff, 0xff, 0xff], 'white'],
  ]) {
    const px = Buffer.alloc(W * H * 4);
    for (let i = 0; i < W * H; i++) {
      const o = i * 4;
      px[o] = bg[0];
      px[o + 1] = bg[1];
      px[o + 2] = bg[2];
      px[o + 3] = 255;
    }
    for (let i = 0; i < W * H; i++)
      if (grid[i]) {
        const o = i * 4;
        px[o] = MR;
        px[o + 1] = MG;
        px[o + 2] = MB;
      }
    strokeLoops(loops, SW, (x, y) => {
      const o = (y * W + x) * 4;
      px[o] = BR;
      px[o + 1] = BG;
      px[o + 2] = BB;
    });
    writeFileSync(
      new URL(`preview-${variant.file.replace('fromcubes-', '').replace('.svg', '')}-${name}.png`, import.meta.url),
      encodePng(W, H, px),
    );
  }
}
console.log('icons + previews written');
