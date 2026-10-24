/*
 * player.js: draws a piece into a <pre>, plays it only while it is on screen,
 * and holds the first frame for anyone who prefers reduced motion.
 *
 *   import { play } from "./player.js";
 *   const stop = play(preElement, await import("./pieces/moonlit-sea.js"));
 */

import { withLook, restyle } from "./glyphs.js";
import { paint, renderMode, cellAspect, CELL_W, GlyphAtlas } from "./canvas.js";

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };
// Braille and the long diagonals fall back to a wider font than the cell in
// Menlo and Consolas, so each one is boxed to exactly one cell.
const WIDE = /[\u2800-\u28FF\u27CB\u27CD]/g;
const BOX = 'display:inline-block;width:1ch;overflow:hidden;vertical-align:top';
const esc = (s) => s.replace(/[&<>]/g, (c) => ESC[c]).replace(WIDE, (c) => `<i style="${BOX};font-style:normal">${c}</i>`);

/** Frame (string or {text,color}) to HTML. Colour runs become one span each. */
export function frameHTML(frame, palette, ink) {
  if (typeof frame === "string") return esc(frame);
  const T = frame.text.split("\n"), C = frame.color.split("\n");
  let out = "";
  for (let y = 0; y < T.length; y++) {
    const t = [...T[y]], c = [...C[y]];
    let run = "", key = c[0];
    const flush = () => {
      if (!run) return;
      const hex = key !== " " && palette && palette[key];
      out += hex ? `<span style="color:${hex}">${esc(run)}</span>` : esc(run);
      run = "";
    };
    for (let x = 0; x < t.length; x++) {
      if (c[x] !== key) { flush(); key = c[x]; }
      run += t[x];
    }
    flush();
    if (y < T.length - 1) out += "\n";
  }
  return out;
}

export const frameText = (f) => (typeof f === "string" ? f : f.text);

/**
 * Play a piece module in a <pre>. Options: speed (1), still (false: honour
 * reduced motion), look ({ look, chars, all, mono, gamma }, see glyphs.js),
 * onFrame(frame, t).
 */
export function play(pre, mod, opts = {}) {
  const meta = mod.meta, look = { ...(opts.look || {}) };
  if (meta.cell === "square" && look.lift === undefined) look.lift = false; // photos keep their true colours
  if (meta.dots) for (const k in meta.dots) if (look[k] === undefined) look[k] = meta.dots[k]; // the piece's own halftone tuning
  const mode = renderMode(meta, look);
  const speed = opts.speed ?? 1;
  const reduce = opts.still ?? (typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches);
  // Square-cell pieces keep their shape as text by closing up the lines.
  pre.style.lineHeight = meta.cell === "square" ? String(CELL_W) : "";
  let render;
  if (opts.dom) { // the old way: rewrite the <pre> each frame (selectable text, slower)
    if (pre._canvas) { pre._canvas.remove(); pre._canvas = null; pre.style.display = ""; }
    const draw = withLook(mod.default(), meta.palette, look);
    render = (t) => {
      const f = draw(t);
      pre.innerHTML = frameHTML(f, f.palette || meta.palette);
      if (opts.onFrame) opts.onFrame(f, t);
    };
  } else {
    // Everything draws on a canvas over the <pre>: halftone looks as true
    // circles or squares, text looks through a glyph atlas. The <pre> keeps
    // its prerendered text for screen readers, search and no-JS visitors.
    const draw = mode === "text" ? withLook(mod.default(), meta.palette, look) : mod.default();
    // Pictures in a text look: below MERGE_PX a cell is too small to read, so k x k cells
    // merge into one glyph (see restyleMerged). Same look, a fraction of the draw calls.
    const raw = mode === "text" && meta.cell === "square" ? mod.default() : null, MERGE_PX = 5;
    if (!pre._canvas) {
      pre._canvas = document.createElement("canvas");
      pre._canvas.setAttribute("aria-hidden", "true");
      pre._canvas.style.display = "block";
      pre._canvas.style.maxWidth = "100%";
      pre.after(pre._canvas);
    }
    const cv = pre._canvas, ctx = cv.getContext("2d"), aspect = cellAspect(meta), atlas = new GlyphAtlas();
    // Read the font size and colour from CSS rarely, not every frame: getComputedStyle
    // forces a style pass, which is what made big pages stutter.
    let px = 12, color = "#e4e4e7", checked = -1;
    const measure = () => {
      pre.style.display = "";
      const cs = getComputedStyle(pre); px = parseFloat(cs.fontSize) || 12; color = cs.color;
      pre.style.display = "none";
    };
    measure();
    render = (t) => {
      const now = performance.now();
      if (now - checked > 500) { checked = now; measure(); }
      const cw = px * CELL_W, ch = cw * aspect, dpr = Math.min(2, window.devicePixelRatio || 1);
      const k = raw && cw < MERGE_PX ? Math.ceil(MERGE_PX / cw) : 1;
      const f = k > 1 ? restyle(raw(t), meta.palette, { ...look, merge: k }) : draw(t);
      const W = Math.ceil(meta.cols * cw), H = Math.ceil(meta.rows * ch);
      if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
        cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
        cv.style.width = W + "px"; cv.style.height = H + "px";
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      paint(ctx, f, f.palette || meta.palette, { ...look, cw: cw * k, ch: ch * k, mode, ink: color, atlas, dpr });
      if (opts.onFrame) opts.onFrame(f, t);
    };
  }
  render(opts.t0 ?? 0);
  if (reduce || meta.still) return () => {};
  let raf = 0, visible = true, elapsed = opts.t0 ?? 0, prev = 0, stopped = false;
  const step = 1000 / Math.min(meta.fps, opts.maxFps || 60);
  // A random phase per player: a page of cards started together would otherwise all
  // redraw on the same frame (one long frame, then idle ones), which reads as stutter.
  let last = (typeof performance !== "undefined" ? performance.now() : 0) - Math.random() * step;
  const loop = (now) => {
    if (stopped) return;
    raf = requestAnimationFrame(loop);
    if (!visible) { prev = now; return; }
    if (prev) elapsed += ((now - prev) / 1000) * speed;
    prev = now;
    if (now - last < step) return;
    last = now - ((now - last) % step); // keep the phase instead of snapping to this frame
    render(elapsed);
  };
  let io;
  if (typeof IntersectionObserver !== "undefined") {
    io = new IntersectionObserver((es) => { visible = es[0].isIntersecting; }, { rootMargin: "100px" });
    io.observe(pre._canvas || pre);
  }
  raf = requestAnimationFrame(loop);
  return () => { stopped = true; cancelAnimationFrame(raf); if (io) io.disconnect(); };
}
