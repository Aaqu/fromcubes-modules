// Traces the black artwork in a PNG into SVG paths, with no external tools:
// zlib is enough to decode the PNG, and the rest is contour walking.
import { readFileSync, writeFileSync } from 'node:fs';
import { inflateSync, deflateSync } from 'node:zlib';

// ---------- PNG decode (8-bit, colour type 6/2, non-interlaced) ----------

export function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let pos = 8;
  let width = 0;
  let height = 0;
  let channels = 4;
  const idat = [];

  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);

    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const depth = data[8];
      const colour = data[9];
      if (depth !== 8) throw new Error(`unsupported bit depth ${depth}`);
      if (data[12] !== 0) throw new Error('interlaced PNG not supported');
      channels = colour === 6 ? 4 : colour === 2 ? 3 : colour === 0 ? 1 : 0;
      if (!channels) throw new Error(`unsupported colour type ${colour}`);
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') break;

    pos += 12 + len;
  }

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(stride * height);

  // Undo the per-scanline filters. Each line starts with its filter byte.
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    const cur = out.subarray(y * stride, (y + 1) * stride);

    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? cur[i - channels] : 0;
      const b = prev ? prev[i] : 0;
      const c = prev && i >= channels ? prev[i - channels] : 0;
      let value = line[i];

      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[i] = value & 0xff;
    }
  }

  return { width, height, channels, data: out };
}

// ---------- mask ----------

/** True where the pixel is dark and opaque — the artwork, not the background. */
export function toMask({ width, height, channels, data }, threshold = 128) {
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const o = i * channels;
    const alpha = channels === 4 ? data[o + 3] : 255;
    const luma =
      channels === 1 ? data[o] : 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
    mask[i] = alpha > 128 && luma < threshold ? 1 : 0;
  }
  return mask;
}

/** Box-downsamples the mask; a cell is set when most of its source pixels were. */
export function downsample(mask, width, height, size) {
  const out = new Uint8Array(size * size);
  const sx = width / size;
  const sy = height / size;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      const y0 = Math.floor(y * sy);
      const y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));

      let on = 0;
      let total = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          on += mask[yy * width + xx];
          total++;
        }
      }
      out[y * size + x] = on * 2 >= total ? 1 : 0;
    }
  }
  return out;
}

// ---------- contour tracing ----------

/**
 * Walks the boundary between set and unset cells. Each filled cell contributes
 * its exposed sides, wound so that outlines run one way and holes the other —
 * which is what lets one path with evenodd draw both.
 */
export function traceContours(mask, w, h) {
  const at = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : mask[y * w + x]);
  const edges = new Map(); // "x,y" -> [[x,y], ...]

  const add = (ax, ay, bx, by) => {
    const key = `${ax},${ay}`;
    const list = edges.get(key);
    if (list) list.push([bx, by]);
    else edges.set(key, [[bx, by]]);
  };

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!at(x, y)) continue;
      if (!at(x, y - 1)) add(x, y, x + 1, y);
      if (!at(x + 1, y)) add(x + 1, y, x + 1, y + 1);
      if (!at(x, y + 1)) add(x + 1, y + 1, x, y + 1);
      if (!at(x - 1, y)) add(x, y + 1, x, y);
    }
  }

  const loops = [];
  while (edges.size) {
    const startKey = edges.keys().next().value;
    const loop = [];
    let key = startKey;

    for (;;) {
      const list = edges.get(key);
      if (!list || !list.length) break;
      const [nx, ny] = list.pop();
      if (!list.length) edges.delete(key);

      const [cx, cy] = key.split(',').map(Number);
      loop.push([cx, cy]);
      key = `${nx},${ny}`;
      if (key === startKey) break;
    }
    if (loop.length > 2) loops.push(loop);
  }
  return loops;
}

/** Drops collinear runs and staircase noise. */
export function simplify(points, epsilon) {
  if (points.length < 4) return points;

  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;

  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop();
    let index = -1;
    let far = epsilon;

    const [ax, ay] = points[first];
    const [bx, by] = points[last];
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy) || 1;

    for (let i = first + 1; i < last; i++) {
      const [px, py] = points[i];
      const d = Math.abs(dy * px - dx * py + bx * ay - by * ax) / len;
      if (d > far) {
        far = d;
        index = i;
      }
    }

    if (index !== -1) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }

  return points.filter((_, i) => keep[i]);
}

// ---------- PNG encode, so the result can be looked at ----------

export function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'ascii');
    data.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

let crcTable = null;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** Scanline-fills the loops with the even-odd rule, so holes stay holes. */
export function rasterise(loops, width, height, scale = 1, offset = [0, 0]) {
  const rgba = Buffer.alloc(width * height * 4);
  const polys = loops.map((loop) =>
    loop.map(([x, y]) => [x * scale + offset[0], y * scale + offset[1]]),
  );

  for (let y = 0; y < height; y++) {
    const sy = y + 0.5;
    const crossings = [];
    for (const poly of polys) {
      for (let i = 0; i < poly.length; i++) {
        const [x1, y1] = poly[i];
        const [x2, y2] = poly[(i + 1) % poly.length];
        if (y1 === y2) continue;
        if (sy >= Math.min(y1, y2) && sy < Math.max(y1, y2)) {
          crossings.push(x1 + ((sy - y1) / (y2 - y1)) * (x2 - x1));
        }
      }
    }
    crossings.sort((a, b) => a - b);
    for (let i = 0; i + 1 < crossings.length; i += 2) {
      const from = Math.max(0, Math.ceil(crossings[i] - 0.5));
      const to = Math.min(width - 1, Math.floor(crossings[i + 1] - 0.5));
      for (let x = from; x <= to; x++) {
        const o = (y * width + x) * 4;
        rgba[o] = 20;
        rgba[o + 1] = 24;
        rgba[o + 2] = 29;
        rgba[o + 3] = 255;
      }
    }
  }
  return rgba;
}

export { readFileSync, writeFileSync };
