/*
 * glyphs.js: redraw any piece in a different set of characters, its "look".
 * Each cell's darkness = how much ink its glyph covers x how bright its colour
 * is; the look's characters are sorted light to dark and the nearest one wins.
 * Works in the browser and in Node, no DOM.
 *
 *   import { restyle } from "./glyphs.js";
 *   const frame2 = restyle(frame, meta.palette, { look: "dots" });
 */

// Ink coverage (0..100) of each safe glyph in Menlo, measured once in a canvas.
// Packed as glyph + one char code: coverage = (code - 48) / 0.74.
const PACKED = "0L1@2C3D4E5E6H7?8J9H!9\":#I$G%F&H'5(<)<*@+<,7-7.5/<:8;:<===>=?=@NAFBKCADIEFFCGFHHIBJ@KHL?MMNNOHPEQJRISET@UFVDWLXEY@ZE[=\\<]>^:_7`2aDbGc=dGeCf@gIhDi>j@kDl=mFnAoBpGqFr;s@t?uAv?wDx@yCz?{@|=}@~:─7━=│=┃G┄6┅:┆;┇E┈5┉9┊:┋C┌:┍=┎@┏C┐:┑=┒@┓C└:┕=┖?┗A┘:┙=┚?┛A├@┝C┞E┟E┠J┡G┢H┣L┤@┥C┦E┧E┨J┩G┪H┫L┬>┭@┮@┯C┰C┱E┲E┳H┴=┵@┶@┷B┸A┹D┺D┻F┼C┽E┾E┿H╀H╁H╂M╃J╄J╅K╆K╇K╈M╉N╊N╋Q╌7╍<╎;╏D═?║I╒?╓B╔E╕?╖B╗E╘=╙@╚C╛=╜@╝C╞C╟K╠M╡C╢K╣M╤D╥D╦H╧C╨B╩F╪I╫N╬Q╭:╮:╯9╰9╱>╲>╳K╴4╵6╶4╷7╸7╹;╺7╻=╼:╽C╾:╿B▀V▁:▂C▃L▄V▅_▆h▇q█z▉s▊j▋`▌V▍M▎C▏9▐V░C▒[▓p▔:▕9▖C▗C▘C▙h▚V▛h▜h▝C▞V▟h·3•9●T○@◦5■\\□C▪C▫<◆H◇?▲H△?▼H▽@◀G▶G►@◄@≈=≡C°7✓8✗@♥N×=÷;±A→9←9↑9↓:↗:↘:↙:↖:";
const COVER = { " ": 0 };
for (let i = 0; i < PACKED.length; i += 2) COVER[PACKED[i]] = (PACKED.charCodeAt(i + 1) - 48) / 0.74;
// Shade blocks are drawn as their nominal density rather than their measured ink.
Object.assign(COVER, { "░": 25, "▒": 50, "▓": 75, "█": 100 });
const cover = (ch) => {
  if (ch in COVER) return COVER[ch];
  const c = ch.codePointAt(0);
  if (c >= 0x2800 && c <= 0x28ff) { let n = 0, b = c - 0x2800; while (b) { n += b & 1; b >>= 1; } return n * 7; }
  return 30;
};

/** The looks offered everywhere. chars run from light to dark once sorted. */
export const LOOKS = {
  original: { label: "Original", chars: null },
  dots: { label: "Halftone dots", chars: " ·•●" },
  ascii: { label: "ASCII", chars: " .,-~:;=!*#$@" },
  dense: { label: "Dense ASCII", chars: " .'`^\",:;Il!i><~+_-?][}{1)(|/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$" },
  numbers: { label: "Numbers", chars: " 1723456980" },
  binary: { label: "Binary", chars: " 01" },
  letters: { label: "Letters", chars: " ilcoeaxkdbAHMW" },
  blocks: { label: "Blocks", chars: " ░▒▓█" },
  squares: { label: "Squares", chars: " ·▪■" },
  lines: { label: "Lines", chars: " ╌─━═" },
  // On canvas: square pixels switched on and off by an 8x8 Bayer pattern. As text
  // (terminal, Copy as text): the same ordered dither in full blocks and spaces.
  dither: { label: "Dither", chars: " █", sample: "▚▞▚▞" },
};
const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
const ditherCh = (d, x, y) => (d > (BAYER4[(y & 3) * 4 + (x & 3)] + 0.5) / 16 ? "█" : " ");

const rampCache = new Map();
/** Sort a string of characters by ink, light to dark, keeping a leading space. */
export function ramp(chars) {
  if (rampCache.has(chars)) return rampCache.get(chars);
  const uniq = [...new Set([...chars])].filter((c) => c !== "\n" && c !== "\t");
  const r = uniq.sort((a, b) => cover(a) - cover(b));
  if (r[0] !== " ") r.unshift(" ");
  rampCache.set(chars, r);
  return r;
}

const lumCache = new Map();
const lum = (hex) => {
  if (!hex) return 0.88;
  if (lumCache.has(hex)) return lumCache.get(hex);
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  lumCache.set(hex, L);
  return L;
};
// In a look, size carries the shading, so colours are lifted to stay visible.
const liftCache = new Map();
function lift(palette) {
  if (!palette) return palette;
  if (liftCache.has(palette)) return liftCache.get(palette);
  const out = {};
  for (const [k, hex] of Object.entries(palette)) {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
    const sat = d ? d / (1 - Math.abs(2 * l - 1)) : 0;
    let h = 0;
    if (d) h = mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    const L = Math.max(l, 0.2 + 0.5 * Math.sqrt(l)), C = (1 - Math.abs(2 * L - 1)) * sat, X = C * (1 - Math.abs((h % 2) - 1)), m = L - C / 2;
    const [R, G, B] = h < 1 ? [C, X, 0] : h < 2 ? [X, C, 0] : h < 3 ? [0, C, X] : h < 4 ? [0, X, C] : h < 5 ? [X, 0, C] : [C, 0, X];
    out[k] = "#" + [R, G, B].map((v) => Math.round((v + m) * 255).toString(16).padStart(2, "0")).join("");
  }
  liftCache.set(palette, out);
  return out;
}
const isShade = (c) => c >= 0x2580 && c <= 0x259f;

/**
 * Redraw a frame in a look. opts: look (a LOOKS key), chars (custom set, wins
 * over look), all (map every glyph, not just shading blocks), mono (drop colour),
 * gamma (contrast: below 1 lifts darks, above 1 deepens them; default 0.75),
 * lift (false keeps the original colours; by default they are brightened, and
 * the frame carries its own palette).
 */
/**
 * Darkness of every cell, 0..1 after stretching to the frame's own range, or
 * -1 for a cell a look leaves alone (blank, or text/line work unless all).
 * Returns { T, C, D, w, h } with T/C as arrays of rows of characters.
 */
// ASCII ramp punctuation. A frame drawn almost only in these, with next to no letters,
// is a shaded render (a spinning torus, a plasma), so its punctuation is shading too.
const RAMP_PUNCT = new Set(".,:;-~=+*!#%@$&");
function rampShaded(T) {
  let ink = 0, ramp = 0, alnum = 0;
  for (const row of T) for (const ch of row) {
    if (ch === " ") continue;
    ink++;
    if (RAMP_PUNCT.has(ch)) ramp++;
    else { const c = ch.charCodeAt(0); if ((c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122)) alnum++; }
  }
  return ink > 0 && ramp >= ink * 0.5 && alnum < ink * 0.05;
}
/** Which characters of this frame a look redraws: shading blocks, plus ramp punctuation in shaded renders. */
export function shadeTester(T) {
  const rs = rampShaded(T);
  return (ch) => isShade(ch.codePointAt(0)) || (rs && RAMP_PUNCT.has(ch));
}

export function densityGrid(frame, palette, opts = {}) {
  const str = typeof frame === "string";
  const T = (str ? frame : frame.text).split("\n").map((r) => [...r]);
  const C = str ? null : frame.color.split("\n").map((r) => [...r]);
  const shade = opts.all ? null : shadeTester(T);
  const D = T.map((row, y) => row.map((ch, x) => {
    if (ch === " " || (!opts.all && !shade(ch))) return -1;
    const k = C && C[y][x];
    return (cover(ch) / 100) * lum(k && k !== " " && palette ? palette[k] : null);
  }));
  let max = 0, min = Infinity;
  for (const row of D) for (const d of row) { if (d > max) max = d; if (d >= 0.004 && d < min) min = d; }
  const span = max - min > 0.05 ? max - min : max, lo = max - min > 0.05 ? min : 0, gamma = opts.gamma ?? 0.35;
  for (const row of D) for (let x = 0; x < row.length; x++) {
    const d = row[x];
    if (d < 0) continue;
    row[x] = d < 0.004 || !span ? 0 : Math.max(0.0001, Math.pow(Math.max(0, d - lo) / span, gamma));
  }
  return { T, C, D, w: T[0] ? T[0].length : 0, h: T.length };
}

export function restyle(frame, palette, opts = {}) {
  const chars = opts.chars || (LOOKS[opts.look] || LOOKS.original).chars;
  const str = typeof frame === "string";
  if (!chars) return opts.mono && !str ? frame.text : frame;
  const R = ramp(chars), n = R.length - 1;
  if (opts.look === "dither" && !opts.chars) opts = { ...opts, all: true }; // dither covers line art and text too, as on canvas
  if (opts.merge > 1 && !str) return restyleMerged(frame, palette, opts, R, opts.merge);
  const { T, D } = densityGrid(frame, palette, opts);
  // every inked cell gets at least the lightest glyph, like a halftone screen
  const dither = opts.look === "dither" && !opts.chars;
  const out = T.map((row, y) => row.map((ch, x) => {
    const d = D[y][x];
    return d < 0 ? ch : d === 0 ? " " : dither ? ditherCh(d, x, y) : R[1 + Math.min(n - 1, Math.floor(d * n))];
  }).join("")).join("\n");
  return str || opts.mono ? out : { text: out, color: frame.color, palette: opts.lift === false ? palette : lift(palette) };
}

/**
 * The same look on a coarser grid: every k x k block of cells becomes one character
 * (mean darkness, colour of its darkest-inked cell). Pictures with tiny cells use it so
 * a thumbnail draws a few thousand legible glyphs instead of 20,000 unreadable ones.
 */
function restyleMerged(frame, palette, opts, R, k) {
  const n = R.length - 1, { T, C, D, w, h } = densityGrid(frame, palette, opts);
  const W = Math.ceil(w / k), H = Math.ceil(h / k), text = [], color = [];
  for (let by = 0; by < H; by++) {
    let tr = "", cr = "";
    for (let bx = 0; bx < W; bx++) {
      let sum = 0, cnt = 0, best = -1, key = " ", keep = null;
      for (let y = by * k; y < Math.min(h, by * k + k); y++) for (let x = bx * k; x < Math.min(w, bx * k + k); x++) {
        const d = D[y][x];
        if (d < 0) { if (T[y][x] !== " " && keep === null) keep = [T[y][x], C ? C[y][x] : " "]; continue; }
        sum += d; cnt++;
        if (d > best) { best = d; key = C ? C[y][x] : " "; }
      }
      if (!cnt && keep) { tr += keep[0]; cr += keep[1]; continue; }
      const d = cnt ? sum / cnt : 0;
      tr += d === 0 ? " " : opts.look === "dither" && !opts.chars ? ditherCh(d, bx, by) : R[1 + Math.min(n - 1, Math.floor(d * n))];
      cr += key;
    }
    text.push(tr); color.push(cr);
  }
  const out = text.join("\n");
  return opts.mono ? out : { text: out, color: color.join("\n"), palette: opts.lift === false ? palette : lift(palette) };
}

export { lift, cover, isShade };

/** Wrap a piece's draw function so every frame comes out in a look. */
export function withLook(draw, palette, opts) {
  if (!opts || (!opts.chars && (!opts.look || opts.look === "original") && !opts.mono)) return draw;
  return (t) => restyle(draw(t), palette, opts);
}
