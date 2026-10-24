/*
 * canvas.js: draw a piece's frame onto a canvas. Used for the halftone looks
 * (true circles and squares sized by each cell's darkness), for square-cell
 * pieces, and for image, wallpaper, thumbnail, GIF and video exports.
 */
import { densityGrid, lift, LOOKS, restyle, cover, isShade, shadeTester } from "./glyphs.js";

export const FONT = 'Menlo, Consolas, "DejaVu Sans Mono", "Liberation Mono", monospace';
/** Width of one monospace cell as a fraction of the font size. */
export const CELL_W = 0.602;

/** Cell height / width: 1 for square-cell pieces, about 1.66 for text pieces. */
export const cellAspect = (meta) => (meta && meta.cell === "square" ? 1 : 1 / CELL_W);

/** Canvas-drawn looks. Anything else is drawn as text. */
export const SHAPE_LOOKS = { dots: "circle", squares: "square", dither: "dither" };

/** Which way a piece is drawn for a look: "circle", "square" or "text". */
export function renderMode(meta, look = {}) {
  if (look.chars) return "text";
  const k = !look.look || look.look === "original" ? (meta && meta.look) || "original" : look.look;
  return SHAPE_LOOKS[k] || "text";
}

/** Old helper kept for callers that size by font: [cell width, cell height]. */
export function cellSize(ctx, px, aspect = 1 / CELL_W) {
  return [px * CELL_W, px * CELL_W * aspect];
}

/**
 * Draw one frame with its top-left at x, y and cells cw x ch pixels.
 * opts: ink, mode ("text" | "circle" | "square"), size (largest dot as a
 * share of the cell, default 0.85), steps (0 = smooth sizes, n = n sizes,
 * default 3), invert (on light paper: dark areas get the big dots, as in
 * print), plus look options for the density (all, gamma, mono).
 */
// Players read the ink from CSS ("rgb(228, 228, 231)"); the pixel painters need "#rrggbb".
const hexCache = new Map();
export function toHex(c) {
  if (!c || (c[0] === "#" && c.length === 7)) return c;
  let h = hexCache.get(c);
  if (h) return h;
  if (c[0] === "#" && c.length === 4) h = "#" + [1, 2, 3].map((i) => c[i] + c[i]).join("");
  else { const m = c.match(/\d+(\.\d+)?/g); h = m && m.length >= 3 ? "#" + m.slice(0, 3).map((v) => Math.max(0, Math.min(255, Math.round(+v))).toString(16).padStart(2, "0")).join("") : "#e4e4e7"; }
  hexCache.set(c, h);
  return h;
}

export function paint(ctx, frame, palette, opts) {
  if (opts.ink && !(opts.ink[0] === "#" && opts.ink.length === 7)) opts = { ...opts, ink: toHex(opts.ink) };
  const { x = 0, y = 0, cw, ch, ink = "#e4e4e7", mode = "text", size = 0.85, steps = 3 } = opts;
  if (frame.palette) palette = frame.palette;
  if (mode === "text") return paintText(ctx, frame, palette, x, y, cw, ch, ink, opts.atlas, opts.dpr);
  if (mode === "dither") return cw === ch ? paintTone(ctx, frame, palette, { ...opts, dither: true }) : paintDitherImage(ctx, frame, palette, opts);
  if (!opts.invert && mode === "circle") return paintTone(ctx, frame, palette, opts);
  // A steeper curve than the text looks: mid-tones stay small, only light grows.
  const { T, C, D } = densityGrid(frame, palette, { ...opts, gamma: (opts.gamma ?? 0.75) * (opts.dotCurve ?? 1.9) });
  const minDot = opts.dotMin ?? 0.22;
  const inv = !!opts.invert, pal = opts.mono ? null : inv || opts.lift === false ? palette : lift(palette);
  // Tall text cells hold two or more dots so the screen stays square.
  const sub = Math.max(1, Math.round(ch / cw)), sh = ch / sub;
  const unit = Math.min(cw, sh), paths = new Map();
  const pathFor = (k) => {
    const col = (k && k !== " " && pal && pal[k]) || ink;
    let p = paths.get(col); if (!p) { p = new Path2D(); paths.set(col, p); }
    return p;
  };
  const text = [];
  for (let r = 0; r < T.length; r++) {
    const row = T[r], dr = D[r];
    for (let c = 0; c < row.length; c++) {
      const d = dr[c];
      if (d < 0) { if (row[c] !== " ") text.push([r, c]); continue; }
      if (d === 0 && !inv) continue;
      const p = pathFor(C && C[r][c]);
      const v0 = inv ? 1 - d : d, v = steps ? Math.ceil(v0 * steps) / steps : v0;
      if (inv && v0 < 0.06) continue; // white stays paper
      const half = 0.5 * unit * size * (minDot + (1 - minDot) * v); // smallest dot stays visible
      if (half < 0.15) continue;
      for (let s = 0; s < sub; s++) {
        const cx = x + (c + 0.5) * cw, cy = y + r * ch + (s + 0.5) * sh;
        if (mode === "circle") { p.moveTo(cx + half, cy); p.arc(cx, cy, half, 0, Math.PI * 2); }
        else p.rect(cx - half, cy - half, half * 2, half * 2);
      }
    }
  }
  // backing: a faint wash of each cell's own colour behind its dot, so a
  // halftone of a bright photo keeps its light instead of going muddy.
  if (opts.backing && !inv) {
    ctx.globalAlpha = opts.backing;
    for (let r = 0; r < T.length; r++) for (let c = 0; c < T[r].length; c++) {
      if (D[r][c] <= 0) continue;
      const k = C && C[r][c]; ctx.fillStyle = (k && k !== " " && pal && pal[k]) || ink;
      ctx.fillRect(x + c * cw, y + r * ch, cw + 0.5, ch + 0.5);
    }
    ctx.globalAlpha = 1;
  }
  for (const [col, p] of paths) { ctx.fillStyle = opts.boost ? boostHex(col, opts.boost) : col; ctx.fill(p); }
  // Text and line work a look leaves alone are still drawn as characters.
  if (text.length) {
    ctx.font = `${cw / CELL_W}px ${FONT}`; ctx.textBaseline = "middle";
    for (const [r, c] of text) {
      const k = C && C[r][c];
      ctx.fillStyle = (!opts.mono && k && k !== " " && palette && palette[k]) || ink;
      ctx.fillText(T[r][c], x + c * cw, y + (r + 0.5) * ch);
    }
  }
}

/**
 * Glyph atlas: each glyph in each colour is drawn once into an offscreen tile
 * and then stamped with drawImage, which is many times cheaper than fillText.
 * One atlas per player; it resets itself when the cell size changes.
 */
export class GlyphAtlas {
  constructor() { this.key = ""; this.map = new Map(); }
  reset(cw, ch, dpr) {
    this.tw = Math.max(1, Math.ceil(cw * dpr)); this.th = Math.max(1, Math.ceil(ch * dpr));
    this.cols = Math.max(1, Math.floor(2048 / this.tw)); this.n = 0; this.map.clear();
    this.canvas = document.createElement("canvas");
    this.canvas.width = this.cols * this.tw; this.canvas.height = this.th * 8;
    this.ctx = this.canvas.getContext("2d");
    this.font = `${(cw / CELL_W) * dpr}px ${FONT}`;
  }
  tile(g, col) {
    const k = g + col;
    let t = this.map.get(k);
    if (t) return t;
    const i = this.n++, sx = (i % this.cols) * this.tw, sy = Math.floor(i / this.cols) * this.th;
    if (sy + this.th > this.canvas.height) { // grow, keeping what is drawn
      const old = this.canvas; this.canvas = document.createElement("canvas");
      this.canvas.width = old.width; this.canvas.height = old.height * 2;
      this.ctx = this.canvas.getContext("2d"); this.ctx.drawImage(old, 0, 0);
    }
    const c = this.ctx;
    c.save(); c.beginPath(); c.rect(sx, sy, this.tw, this.th); c.clip();
    c.font = this.font; c.textBaseline = "middle"; c.fillStyle = col;
    c.fillText(g, sx, sy + this.th / 2); c.restore();
    t = [sx, sy]; this.map.set(k, t);
    return t;
  }
}

/**
 * True-tone halftone: each dot's AREA is the cell's brightness (glyph ink x
 * colour light), over the full range from a speck to a full cell, and every dot
 * keeps a bright version of its colour. Shadows are dark because their dots are
 * small, not because they are muddy, which is how printed halftone reads.
 * tone: { gamma (0.9), floor (smallest dot, 0.06), sat (colour lift, 0.85) }
 */
const LV = { "▁": 0.135, "▂": 0.257, "▃": 0.378, "▄": 0.51, "▅": 0.635, "▆": 0.757, "▇": 0.878, "█": 1 };
const brightCache = new Map();
function brighten(h, k) {
  const key = h + k; let o = brightCache.get(key); if (o) return o;
  const v = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)), mx = Math.max(...v, 1);
  const f = (255 / mx) * k + (1 - k); // k=1: max channel to 255, hue kept
  o = "#" + v.map((c) => Math.round(Math.min(255, c * f)).toString(16).padStart(2, "0")).join("");
  brightCache.set(key, o); return o;
}
function paintTone(ctx, frame, palette, opts) {
  const { x = 0, y = 0, cw, ch, tone = {} } = opts, size = (opts.size ?? 0.51) / 0.85; // 0.85 = a full-cell dot
  const density = Math.max(0.3, opts.density ?? 1.31); // dots per cell along each side; spacing only, not dot size
  const dpr = opts.dpr || 1;
  const lo = tone.lo ?? 0.04, hi = tone.hi ?? 0.985, g = tone.curve ?? 1.1, sat = tone.sat ?? 0.85;
  const T = (typeof frame === "string" ? frame : frame.text).split("\n").map((r) => [...r]);
  const C = typeof frame === "string" || !frame.color ? null : frame.color.split("\n").map((r) => [...r]);
  const rows = T.length, cols = T[0] ? T[0].length : 0;
  const lum = new Map();
  const L = (h) => { if (!h) return 0.88; let v = lum.get(h); if (v === undefined) { const [r, gg, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255); v = 0.2126 * r + 0.7152 * gg + 0.0722 * b; lum.set(h, v); } return v; };
  // brightness of every source cell (glyph ink x colour light); text and line
  // work in non-picture pieces stay as characters unless "all"
  const vals = new Float32Array(rows * cols), keys = new Array(rows * cols), text = [];
  const pictureLike = opts.all || cw === ch, shade = pictureLike ? null : shadeTester(T);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const gch = T[r][c], k = C && C[r][c], hx = k && k !== " " && palette ? palette[k] : null, i = r * cols + c;
    if (gch === " ") { vals[i] = -1; continue; }
    if (!pictureLike && !shade(gch)) { vals[i] = -1; text.push([r, c, gch, hx]); continue; }
    vals[i] = (LV[gch] ?? cover(gch) / 100) * L(hx); keys[i] = hx || opts.ink;
  }
  // percentiles from a 512-bin histogram (a full sort every frame was the bottleneck)
  let vmax = 0, n = 0; for (let i = 0; i < vals.length; i++) if (vals[i] > vmax) vmax = vals[i];
  const HB = 512, hist = new Uint32Array(HB);
  for (let i = 0; i < vals.length; i++) if (vals[i] >= 0) { hist[Math.min(HB - 1, Math.floor((vals[i] / (vmax || 1)) * HB))]++; n++; }
  const P = (q) => { let acc = 0; const want = q * n; for (let k = 0; k < HB; k++) { acc += hist[k]; if (acc >= want) return ((k + 0.5) / HB) * vmax; } return vmax; };
  const a = P(lo), b = Math.max(P(hi), a + 1e-4);
  const SIZES = tone.sizes || [0.2, 0.5, 0.85, 1.32];
  const B4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
  // the dot grid: square spacing set by density, sampled from the source cells
  const step = Math.min(cw, ch) / density, unit = Math.min(cw, ch);
  const W = cols * cw, H = rows * ch, gx = Math.max(1, Math.round(W / step)), gy = Math.max(1, Math.round(H / step));
  const sx = W / gx, sy = H / gy, layers = SIZES.map(() => new Map());
  const maxRadDev = 0.5 * unit * size * SIZES[SIZES.length - 1] * dpr;
  const stamp = maxRadDev <= 6 && typeof ImageData !== "undefined" && !opts.noStamp; // small dots: write pixels directly
  const dots = stamp ? SIZES.map(() => []) : null;
  const pix = opts.dither ? [] : null; // dither: grid cells switched on by an 8x8 Bayer threshold
  const sample = (fx, fy) => { // bilinear brightness, nearest colour
    const c0 = Math.min(cols - 1, Math.max(0, Math.floor(fx))), r0 = Math.min(rows - 1, Math.max(0, Math.floor(fy)));
    const c1 = Math.min(cols - 1, c0 + 1), r1 = Math.min(rows - 1, r0 + 1), tx = Math.min(1, Math.max(0, fx - c0)), ty = Math.min(1, Math.max(0, fy - r0));
    const v = (i) => (vals[i] < 0 ? 0 : vals[i]);
    const val = v(r0 * cols + c0) * (1 - tx) * (1 - ty) + v(r0 * cols + c1) * tx * (1 - ty) + v(r1 * cols + c0) * (1 - tx) * ty + v(r1 * cols + c1) * tx * ty;
    const ni = Math.min(rows - 1, Math.round(fy)) * cols + Math.min(cols - 1, Math.round(fx));
    return [val, keys[ni] || keys[r0 * cols + c0], vals[ni] < 0 && vals[r0 * cols + c0] < 0];
  };
  for (let j = 0; j < gy; j++) for (let i = 0; i < gx; i++) {
    const px = (i + 0.5) * sx, py = (j + 0.5) * sy;
    const [v, hx, empty] = density === 1 && cw === ch ? [vals[j * cols + i], keys[j * cols + i], vals[j * cols + i] < 0] : sample(px / cw - 0.5, py / ch - 0.5);
    if (empty || !hx) continue;
    const t = Math.pow(Math.min(1, Math.max(0, (v - a) / (b - a))), g);
    if (pix) { if (t > (B8[(j & 7) * 8 + (i & 7)] + 0.5) / 64) pix.push(i, j, opts.mono ? opts.ink : brighten(hx, sat)); continue; }
    let lvl = Math.floor(t * SIZES.length - 0.5); const frac = t * SIZES.length - 0.5 - lvl;
    if (frac > (B4[(j & 3) * 4 + (i & 3)] + 0.5) / 16) lvl++;
    if (lvl < 0) continue;
    lvl = Math.min(SIZES.length - 1, lvl);
    const rad = 0.5 * unit * size * SIZES[lvl];
    if (rad < 0.3) continue;
    const fill = opts.mono ? opts.ink : brighten(hx, sat);
    if (stamp) { dots[lvl].push((x + px) * dpr, (y + py) * dpr, rad * dpr, fill); continue; }
    const m = layers[lvl]; let p = m.get(fill); if (!p) m.set(fill, (p = new Path2D()));
    p.moveTo(x + px + rad, y + py); p.arc(x + px, y + py, rad, 0, Math.PI * 2);
  }
  if (pix) stampPixels(ctx, pix, x, y, sx, sy, dpr, opts.over);
  else if (stamp) stampDots(ctx, dots, opts.over);
  else for (const m of layers) for (const [fill, p] of m) { ctx.fillStyle = fill; ctx.fill(p); } // big dots last, so they merge
  if (text.length) {
    ctx.font = `${cw / CELL_W}px ${FONT}`; ctx.textBaseline = "middle";
    for (const [r, c, gch, hx] of text) { ctx.fillStyle = (!opts.mono && hx) || opts.ink; ctx.fillText(gch, x + c * cw, y + (r + 0.5) * ch); }
  }
}

const B8 = [0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60, 28, 52, 20, 62, 30, 54, 22,
  3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25, 15, 47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21];
/* Dither pixels: solid rectangles written straight into one ImageData, edges rounded
   to device pixels so neighbours meet without seams or overlaps. */
// The pixel buffer a stamper writes into: a cleared one for live players (their canvas is
// cleared every frame anyway), or the canvas's current pixels when something is already
// painted underneath, like an export's background.
function pixelBuffer(ctx, over) {
  const cv = ctx.canvas, W = cv.width, H = cv.height;
  if (over) return ctx.getImageData(0, 0, W, H);
  let img = cv._apImg;
  if (!img || img.width !== W || img.height !== H) img = cv._apImg = new ImageData(W, H);
  img.data.fill(0);
  return img;
}
const LE = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
const PACKED = new Map(); // hex -> packed RGBA for stampPixels (stampDots keeps [r, g, b] arrays in RGB)
const pack = (r, g, b) => (LE ? (255 << 24) | (b << 16) | (g << 8) | r : (r << 24) | (g << 16) | (b << 8) | 255) >>> 0;
function stampPixels(ctx, pix, x, y, sx, sy, dpr, over) {
  const cv = ctx.canvas, W = cv.width, H = cv.height;
  const img = pixelBuffer(ctx, over), d32 = new Uint32Array(img.data.buffer);
  for (let k = 0; k < pix.length; k += 3) {
    const i = pix[k], j = pix[k + 1], hex = pix[k + 2];
    let c = PACKED.get(hex);
    if (c === undefined) { const [r, g, b] = [1, 3, 5].map((o) => parseInt(hex.slice(o, o + 2), 16)); c = pack(r, g, b); PACKED.set(hex, c); }
    const x0 = Math.max(0, Math.round((x + i * sx) * dpr)), x1 = Math.min(W, Math.round((x + (i + 1) * sx) * dpr));
    const y0 = Math.max(0, Math.round((y + j * sy) * dpr)), y1 = Math.min(H, Math.round((y + (j + 1) * sy) * dpr));
    for (let yy = y0; yy < y1; yy++) d32.fill(c, yy * W + x0, yy * W + x1);
  }
  ctx.putImageData(img, 0, 0);
}

/*
 * Dither for line art, text and every other non-picture piece: draw the frame as
 * text onto a small canvas where one pixel is one dither pixel (the browser's
 * downscaling averages each pixel's coverage and colour), then switch each pixel on
 * or off against the 8x8 Bayer matrix and write it as a solid block. Shapes, lines
 * and letters all survive as dithered pixels, so borders and rules dither too.
 */
function paintDitherImage(ctx, frame, palette, opts) {
  const { x = 0, y = 0, cw, ch, ink = "#e4e4e7", dpr = 1, density = 1.31 } = opts, sat = (opts.tone && opts.tone.sat) ?? 0.85;
  const T = (typeof frame === "string" ? frame : frame.text).split("\n");
  const cols = T[0] ? [...T[0]].length : 0, rows = T.length;
  const px = Math.max(1 / dpr, Math.min(cw, ch) / (2.6 * Math.max(0.3, density))); // dither pixel, CSS px
  const gw = Math.max(1, Math.ceil((cols * cw) / px)), gh = Math.max(1, Math.ceil((rows * ch) / px));
  const cv = ctx.canvas;
  let off = cv._apDither;
  if (!off) off = cv._apDither = document.createElement("canvas");
  if (off.width !== gw || off.height !== gh) { off.width = gw; off.height = gh; }
  const o = off.getContext("2d", { willReadFrequently: true });
  o.setTransform(1, 0, 0, 1, 0, 0); o.clearRect(0, 0, gw, gh); o.setTransform(1 / px, 0, 0, 1 / px, 0, 0);
  const atlas = opts.atlas || (cv._apDitherAtlas ||= new GlyphAtlas());
  paintText(o, frame, opts.mono ? null : palette, 0, 0, cw, ch, ink, atlas, dpr);
  const src = o.getImageData(0, 0, gw, gh).data;
  const img = pixelBuffer(ctx, opts.over), d32 = new Uint32Array(img.data.buffer), W = cv.width, H = cv.height;
  for (let j = 0; j < gh; j++) {
    const y0 = Math.max(0, Math.round((y + j * px) * dpr)), y1 = Math.min(H, Math.round((y + (j + 1) * px) * dpr));
    if (y1 <= y0) continue;
    for (let i = 0; i < gw; i++) {
      const q = (j * gw + i) * 4, a = src[q + 3];
      if (a < 6 || a / 255 <= (B8[(j & 7) * 8 + (i & 7)] + 0.5) / 64) continue; // coverage against the Bayer threshold
      const r = src[q], g = src[q + 1], b = src[q + 2], mx = Math.max(r, g, b, 1), f = (255 / mx) * sat + (1 - sat);
      const c = pack(Math.min(255, Math.round(r * f)), Math.min(255, Math.round(g * f)), Math.min(255, Math.round(b * f)));
      const x0 = Math.max(0, Math.round((x + i * px) * dpr)), x1 = Math.min(W, Math.round((x + (i + 1) * px) * dpr));
      for (let yy = y0; yy < y1; yy++) d32.fill(c, yy * W + x0, yy * W + x1);
    }
  }
  ctx.putImageData(img, 0, 0);
}

/* Pixel stamper for small dots: anti-aliased coverage masks per radius, written
   into one ImageData and put back once. Far faster than tens of thousands of
   arcs for gallery cards and normal stage sizes. */
const MASKS = new Map(), RGB = new Map();
function maskFor(r, fx, fy) {
  // r quantised to 1/4 px, and the dot centre's sub-pixel offset to 1/4 px,
  // so dots land exactly where they belong instead of snapping to whole pixels
  // (snapping made the spacing uneven, which showed as a faint grid)
  const q = Math.round(r * 4) / 4, ox = Math.round(fx * 4) / 4, oy = Math.round(fy * 4) / 4, key = q * 100 + ox * 10 + oy;
  let m = MASKS.get(key); if (m) return m;
  const R = Math.ceil(q + 1), n = R * 2 + 1, a = new Float32Array(n * n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    let c = 0; for (let sj = 0; sj < 4; sj++) for (let si = 0; si < 4; si++) { const dx = i - R + (si + 0.5) / 4 - ox, dy = j - R + (sj + 0.5) / 4 - oy; if (dx * dx + dy * dy <= q * q) c++; }
    a[j * n + i] = c / 16;
  }
  m = { R, n, a }; MASKS.set(key, m); return m;
}
const rgbOf = (h) => { let v = RGB.get(h); if (!v) { v = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)); RGB.set(h, v); } return v; };
function stampDots(ctx, layers, over) {
  const cv = ctx.canvas, W = cv.width, H = cv.height;
  const img = pixelBuffer(ctx, over), d = img.data;
  for (const L of layers) for (let k = 0; k < L.length; k += 4) {
    const cx = L[k], cy = L[k + 1], bx = Math.floor(cx), by = Math.floor(cy);
    const m = maskFor(L[k + 2], cx - bx - 0.5, cy - by - 0.5), [r, g, b] = rgbOf(L[k + 3]);
    const x0 = bx - m.R, y0 = by - m.R;
    for (let j = 0; j < m.n; j++) { const yy = y0 + j; if (yy < 0 || yy >= H) continue;
      for (let i = 0; i < m.n; i++) { const xx = x0 + i; if (xx < 0 || xx >= W) continue;
        const cov = m.a[j * m.n + i]; if (cov <= 0) continue;
        const o = (yy * W + xx) * 4, A = d[o + 3] / 255, na = cov + A * (1 - cov);
        d[o] = (r * cov + d[o] * A * (1 - cov)) / na; d[o + 1] = (g * cov + d[o + 1] * A * (1 - cov)) / na; d[o + 2] = (b * cov + d[o + 2] * A * (1 - cov)) / na; d[o + 3] = na * 255;
      } }
  }
  ctx.putImageData(img, 0, 0);
}

function paintText(ctx, frame, palette, x, y, cw, ch, ink, atlas, dpr = 1) {
  const T = (typeof frame === "string" ? frame : frame.text).split("\n");
  const C = typeof frame === "string" ? null : frame.color.split("\n");
  if (atlas) {
    const key = cw + "x" + ch + "@" + dpr;
    if (atlas.key !== key) { atlas.reset(cw, ch, dpr); atlas.key = key; }
    const blocks = new Map();
    for (let r = 0; r < T.length; r++) {
      const row = T[r], col = C ? C[r] : null;
      let ci = 0;
      for (const g of row) {
        const k = col && col[ci], c = ci++;
        if (g === " ") continue;
        const fill = (k && k !== " " && palette && palette[k]) || ink;
        if (g === "█") { let p = blocks.get(fill); if (!p) blocks.set(fill, (p = new Path2D())); p.rect(x + c * cw, y + r * ch, cw + 0.5, ch + 0.5); continue; }
        const [sx, sy] = atlas.tile(g, fill);
        ctx.drawImage(atlas.canvas, sx, sy, atlas.tw, atlas.th, x + c * cw, y + r * ch, cw, ch);
      }
    }
    for (const [fill, p] of blocks) { ctx.fillStyle = fill; ctx.fill(p); }
    return;
  }
  ctx.font = `${cw / CELL_W}px ${FONT}`; ctx.textBaseline = "middle";
  for (let r = 0; r < T.length; r++) {
    const row = [...T[r]], col = C ? [...C[r]] : null;
    for (let c = 0; c < row.length; c++) {
      const g = row[c];
      if (g === " ") continue;
      const k = col && col[c];
      ctx.fillStyle = (k && k !== " " && palette && palette[k]) || ink;
      // Block elements look gapped as glyphs at large sizes: paint them as rects.
      if (g === "█") { ctx.fillRect(x + c * cw, y + r * ch, Math.ceil(cw), Math.ceil(ch)); continue; }
      ctx.fillText(g, x + c * cw, y + (r + 0.5) * ch);
    }
  }
}

/** Back-compat: draw a frame sized by font px. Returns [width, height]. */
export function drawFrame(ctx, frame, palette, opts) {
  const { px = 14, aspect = 1 / CELL_W } = opts;
  const cw = px * CELL_W, ch = cw * aspect;
  paint(ctx, frame, palette, { ...opts, cw, ch });
  const T = (typeof frame === "string" ? frame : frame.text).split("\n");
  return [cw * [...T[0]].length, ch * T.length];
}

/** A frame in a look, ready to paint: text looks restyle it, shape looks don't. */
export function frameFor(frame, palette, meta, look = {}) {
  const mode = renderMode(meta, look);
  if (mode !== "text") return { frame, mode };
  const restyled = look.chars || (look.look && look.look !== "original");
  return { frame: restyled ? restyle(frame, palette, look) : look.mono && typeof frame !== "string" ? frame.text : frame, mode };
}

/**
 * Render a frame centred on a canvas of width x height. fit "contain" keeps the
 * whole piece in view with a margin; "cover" fills the canvas edge to edge.
 * meta (for the cell shape) and look are optional.
 */
export function renderTo(canvas, frame, palette, { width, height, bg = "#09090b", ink = "#e4e4e7", fit = "contain", margin = 0.08, meta, look = {} }) {
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = bg; ctx.fillRect(0, 0, width, height);
  const T = (typeof frame === "string" ? frame : frame.text).split("\n");
  const cols = [...T[0]].length, rows = T.length, aspect = cellAspect(meta);
  const m = fit === "cover" ? 1 : 1 - margin * 2;
  const sx = (width * m) / cols, sy = (height * m) / (rows * aspect);
  const cw = fit === "cover" ? Math.max(sx, sy) : Math.min(sx, sy), ch = cw * aspect;
  if (meta && meta.cell === "square" && look.lift === undefined) look = { ...look, lift: false }; // photos keep true colour
  if (meta && meta.dots) look = { ...meta.dots, ...look }; // a piece's own halftone tuning
  const { frame: f, mode } = frameFor(frame, palette, meta, look);
  const light = /^#?[0-9a-f]{6}$/i.test(bg.replace("#", "")) && lumHex(bg) > 0.6;
  paint(ctx, f, palette, { ...look, invert: look.invert ?? light, x: (width - cols * cw) / 2, y: (height - rows * ch) / 2, cw, ch, ink, mode, over: true });
  return canvas;
}

// Brighten a colour by f (1.3 = 30%) keeping its hue, clamped per channel.
const boostCache = new Map();
function boostHex(h, f) {
  const key = h + f; if (boostCache.has(key)) return boostCache.get(key);
  const v = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)), mx = Math.max(...v, 1);
  const k = Math.min(f, 255 / mx), out = "#" + v.map((c) => Math.round(c * k).toString(16).padStart(2, "0")).join("");
  boostCache.set(key, out); return out;
}
function lumHex(h) { h = h.replace("#", ""); const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255); return 0.2126 * r + 0.7152 * g + 0.0722 * b; }

/** Export presets for wallpapers, thumbnails and social images. */
export const PRESETS = {
  "desktop-4k": { label: "Desktop 4K", width: 3840, height: 2160, fit: "cover" },
  desktop: { label: "Desktop 1080p", width: 1920, height: 1080, fit: "cover" },
  phone: { label: "Phone wallpaper", width: 1179, height: 2556, fit: "cover" },
  youtube: { label: "YouTube thumbnail", width: 1280, height: 720, fit: "contain" },
  "github-social": { label: "GitHub social preview", width: 1280, height: 640, fit: "contain" },
  "x-header": { label: "X / Twitter header", width: 1500, height: 500, fit: "cover" },
  "linkedin-banner": { label: "LinkedIn banner", width: 1584, height: 396, fit: "cover" },
  square: { label: "Square post", width: 1080, height: 1080, fit: "contain" },
  story: { label: "Story / Reel", width: 1080, height: 1920, fit: "contain" },
};

export { LOOKS };
