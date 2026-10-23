/*
 * kit.js: the small toolbox every piece is built from. No dependencies, runs
 * the same in a browser and in Node.
 *
 * A piece draws into a Grid and returns grid.frame(). A Grid holds one
 * character and one colour key per cell. Colour keys are single characters
 * that index the piece's meta.palette; a space means "default ink".
 */

export const RAMPS = {
  classic: " .:-=+*#%@",
  fine: " .'`^\",:;Il!i><~+_-?][}{1)(|/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$",
  dots: " .·•●",
  blocks: " ░▒▓█",
  soft: " .,-~:;=!*#$@",
  lines: " -=≡",
};

/** Map 0..1 to a character of a ramp. */
export function ramp(v, chars = RAMPS.classic) {
  const i = Math.max(0, Math.min(chars.length - 1, Math.floor(v * chars.length)));
  return chars[i];
}

export const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smooth = (t) => t * t * (3 - 2 * t);
export const fract = (v) => v - Math.floor(v);
export const TAU = Math.PI * 2;

/** Deterministic PRNG (mulberry32). Same seed, same art on every load. */
export function rng(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ── noise ──────────────────────────────────────────────────────────── */
function hash2(x, y, s) {
  let h = (x * 374761393 + y * 668265263 + s * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
/** 2D value noise in 0..1. */
export function noise2(x, y, seed = 0) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = smooth(x - xi), yf = smooth(y - yi);
  const a = hash2(xi, yi, seed), b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed), d = hash2(xi + 1, yi + 1, seed);
  return lerp(lerp(a, b, xf), lerp(c, d, xf), yf);
}
/** Fractal noise, a few octaves of noise2, in 0..1. */
export function fbm(x, y, octaves = 4, seed = 0) {
  let v = 0, amp = 0.5, f = 1, norm = 0;
  for (let i = 0; i < octaves; i++) {
    v += amp * noise2(x * f, y * f, seed + i * 17);
    norm += amp; amp *= 0.5; f *= 2;
  }
  return v / norm;
}

/* ── colour ─────────────────────────────────────────────────────────── */
export function hsl(h, s, l) {
  h = ((h % 360) + 360) % 360; s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const x = (v) => Math.round(v * 255).toString(16).padStart(2, "0");
  return "#" + x(f(0)) + x(f(8)) + x(f(4));
}
/** Build a palette object from a list of hex colours: keys "0".."9","a".."z". */
export const KEYS = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
export function palette(hexes) {
  const p = {};
  hexes.forEach((h, i) => (p[KEYS[i]] = h));
  return p;
}
/** A gradient palette of n steps between colour stops, for shading by value. */
export function gradient(stops, n = 10) {
  const toRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const rgb = stops.map(toRgb);
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = (i / (n - 1)) * (rgb.length - 1);
    const j = Math.min(rgb.length - 2, Math.floor(t)), f = t - j;
    const c = rgb[j].map((v, k) => Math.round(lerp(v, rgb[j + 1][k], f)));
    out.push("#" + c.map((v) => v.toString(16).padStart(2, "0")).join(""));
  }
  return out;
}

/* ── the grid ───────────────────────────────────────────────────────── */
export class Grid {
  constructor(cols, rows) {
    this.cols = cols; this.rows = rows;
    this.ch = new Array(cols * rows).fill(" ");
    this.co = new Array(cols * rows).fill(" ");
    this.z = new Float32Array(cols * rows);
  }
  clear(ch = " ", co = " ") { this.ch.fill(ch); this.co.fill(co); this.z.fill(-Infinity); return this; }
  inside(x, y) { return x >= 0 && y >= 0 && x < this.cols && y < this.rows; }
  /** Put a character (and optional colour key) at integer x,y. */
  set(x, y, ch, co) {
    x = Math.floor(x); y = Math.floor(y);
    if (!this.inside(x, y)) return;
    const i = x + y * this.cols;
    this.ch[i] = ch; if (co !== undefined) this.co[i] = co;
  }
  /** Depth-tested put: only draws when z is nearer (larger) than what is there. */
  setZ(x, y, z, ch, co) {
    x = Math.floor(x); y = Math.floor(y);
    if (!this.inside(x, y)) return;
    const i = x + y * this.cols;
    if (z <= this.z[i]) return;
    this.z[i] = z; this.ch[i] = ch; if (co !== undefined) this.co[i] = co;
  }
  get(x, y) { return this.inside(x, y) ? this.ch[Math.floor(x) + Math.floor(y) * this.cols] : " "; }
  /** Write a string left to right. */
  text(x, y, s, co) { for (let i = 0; i < s.length; i++) this.set(x + i, y, s[i], co); }
  /** Write a multi-line block (lines split on \n). Spaces are transparent unless solid. */
  block(x, y, s, co, solid = false) {
    s.split("\n").forEach((line, r) => {
      for (let i = 0; i < line.length; i++) if (solid || line[i] !== " ") this.set(x + i, y + r, line[i], co);
    });
  }
  hline(x0, x1, y, ch = "─", co) { for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) this.set(x, y, ch, co); }
  vline(x, y0, y1, ch = "│", co) { for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) this.set(x, y, ch, co); }
  /** Box with light, heavy, double or round corners. */
  box(x, y, w, h, style = "light", co) {
    const S = {
      light: "┌┐└┘─│", heavy: "┏┓┗┛━┃", double: "╔╗╚╝═║", round: "╭╮╰╯─│", ascii: "++++-|",
    }[style] || style;
    this.hline(x + 1, x + w - 2, y, S[4], co); this.hline(x + 1, x + w - 2, y + h - 1, S[4], co);
    this.vline(x, y + 1, y + h - 2, S[5], co); this.vline(x + w - 1, y + 1, y + h - 2, S[5], co);
    this.set(x, y, S[0], co); this.set(x + w - 1, y, S[1], co);
    this.set(x, y + h - 1, S[2], co); this.set(x + w - 1, y + h - 1, S[3], co);
  }
  fill(x, y, w, h, ch = " ", co) { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.set(x + i, y + j, ch, co); }
  /** Bresenham line. */
  line(x0, y0, x1, y1, ch = "*", co) {
    x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let e = dx + dy;
    for (let n = 0; n < 4000; n++) {
      this.set(x0, y0, typeof ch === "function" ? ch(x0, y0) : ch, co);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * e;
      if (e2 >= dy) { e += dy; x0 += sx; }
      if (e2 <= dx) { e += dx; y0 += sy; }
    }
  }
  /** Ellipse outline, corrected for tall cells when aspect=0.5. */
  circle(cx, cy, r, ch = "o", co, aspect = 0.5) {
    const n = Math.max(12, Math.ceil(r * 8));
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU;
      this.set(Math.round(cx + Math.cos(a) * r), Math.round(cy + Math.sin(a) * r * aspect), ch, co);
    }
  }
  /** Call fn(x, y, u, v) for every cell; u,v in 0..1. Write via the return value [ch, co]. */
  shade(fn) {
    for (let y = 0; y < this.rows; y++) for (let x = 0; x < this.cols; x++) {
      const r = fn(x, y, x / (this.cols - 1), y / (this.rows - 1));
      if (r) this.set(x, y, r[0], r[1]);
    }
  }
  /** The frame a piece returns: plain text when no colours were used, else {text, color}. */
  frame() {
    const lines = [], cl = [];
    let colored = false;
    for (let y = 0; y < this.rows; y++) {
      lines.push(this.ch.slice(y * this.cols, (y + 1) * this.cols).join(""));
      const c = this.co.slice(y * this.cols, (y + 1) * this.cols).join("");
      if (!colored && c.trim()) colored = true;
      cl.push(c);
    }
    return colored ? { text: lines.join("\n"), color: cl.join("\n") } : lines.join("\n");
  }
}

/* ── 3D ─────────────────────────────────────────────────────────────── */
export function rotX([x, y, z], a) { const c = Math.cos(a), s = Math.sin(a); return [x, y * c - z * s, y * s + z * c]; }
export function rotY([x, y, z], a) { const c = Math.cos(a), s = Math.sin(a); return [x * c + z * s, y, -x * s + z * c]; }
export function rotZ([x, y, z], a) { const c = Math.cos(a), s = Math.sin(a); return [x * c - y * s, x * s + y * c, z]; }
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const norm = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
/** Perspective-project a point to grid coords. Cells are ~2x taller than wide. */
export function project([x, y, z], cols, rows, fov = 1.6, dist = 4) {
  const k = fov / (z + dist);
  const s = Math.min(cols * 0.5, rows);
  return [cols / 2 + x * k * s, rows / 2 - y * k * s * 0.5, k];
}
/** Draw a wireframe from vertices + edge index pairs. */
export function wire(g, verts, edges, ch = "·", co) {
  for (const [a, b] of edges) g.line(verts[a][0], verts[a][1], verts[b][0], verts[b][1], ch, co);
}

/* ── small text font (3x5) for numbers and short labels ─────────────── */
const F3 = {
  "0": "███│█ █│█ █│█ █│███", "1": " █ │██ │ █ │ █ │███", "2": "███│  █│███│█  │███",
  "3": "███│  █│███│  █│███", "4": "█ █│█ █│███│  █│  █", "5": "███│█  │███│  █│███",
  "6": "███│█  │███│█ █│███", "7": "███│  █│  █│  █│  █", "8": "███│█ █│███│█ █│███",
  "9": "███│█ █│███│  █│███", ":": "   │ █ │   │ █ │   ", " ": "   │   │   │   │   ",
  "-": "   │   │███│   │   ", ".": "   │   │   │   │ █ ", "%": "█ █│  █│ █ │█  │█ █",
};
/** Draw digits in a 3x5 block font. Returns the width used. */
export function bigText(g, x, y, s, co, on = "█") {
  let cx = x;
  for (const c of String(s)) {
    const glyph = F3[c] || F3[" "];
    glyph.split("│").forEach((row, r) => { for (let i = 0; i < 3; i++) if (row[i] !== " ") g.set(cx + i, y + r, on, co); });
    cx += 4;
  }
  return cx - x;
}
