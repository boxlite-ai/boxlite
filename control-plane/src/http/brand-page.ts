/**
 * The one look of every page the control plane itself answers in a browser (app origins: starting,
 * not running, private; sign-in errors), seen by the app's visitors. Quiet on purpose: a white page with the console's own
 * loading mark, the wireframe Box (dashboard BoxCube), a short heading and a line or two. The Box
 * draws itself in while an app starts, is dashed when nothing runs, plain when private and has a
 * broken edge on an error.
 *
 * A starting page also counts the seconds and checks in the background, moving on to the app the
 * moment it answers (a meta refresh stays as the fallback without JavaScript). The only branding is
 * a small "Hosted on BoxLite" at the foot.
 */
import { escapeHtml } from './html.js';

export type PageTone = 'progress' | 'stopped' | 'locked' | 'error';

export interface BrandPage {
  title: string;
  tone: PageTone;
  /** The status label above the heading, e.g. "Starting". */
  label: string;
  heading?: string;
  /** Paragraphs of plain text (escaped here). */
  lines?: string[];
  /** Pre-built body markup instead of heading and lines (sign-in error pages); the caller escapes it. */
  bodyHtml?: string;
  action?: { href: string; text: string };
  /** One small line under everything (escaped; `code` spans allowed via backticks). */
  hint?: string;
  /** A small link under everything (after the hint), e.g. the app in the console for its owner. */
  hintLink?: { href: string; text: string };
  /** Checks again after this many seconds (a starting app). */
  refreshSeconds?: number;
}

/** `text` escaped, with `backticks` as code spans. */
const inline = (text: string) => escapeHtml(text).replace(/`([^`]+)`/g, '<code>$1</code>');

// The Box's faces on a 64×64 grid, as in the console's BoxCube.
const TOP = 'M32 10L54 22L32 34L10 22Z';
const LEFT = 'M10 22L32 34L32 56L10 44Z';
const RIGHT = 'M32 34L54 22L54 44L32 56Z';

function box(tone: PageTone): string {
  const face = (d: string, extra = '') => `<path d="${d}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"${extra}/>`;
  const inner =
    tone === 'progress'
      ? [TOP, LEFT, RIGHT].map((d, i) => face(d, ` class="draw" style="animation-delay:${(i * 0.22).toFixed(2)}s"`)).join('') +
        `<path d="${TOP}" class="lit" fill="hsl(196 100% 42%)" fill-opacity="0"/>`
      : tone === 'error'
        ? face(TOP) + face('M10 22L32 34L32 42M32 50L32 56L10 44Z') + face(RIGHT) + '<path d="M29 42L35 50" stroke="hsl(4 70% 52%)" stroke-width="2"/>'
        : tone === 'stopped'
          ? [TOP, LEFT, RIGHT].map((d) => face(d, ' stroke-dasharray="3 3"')).join('')
          : face(TOP) + face(LEFT) + face(RIGHT);
  return `<svg class="box" viewBox="0 0 64 64" width="56" height="56" aria-hidden="true">${inner}</svg>`;
}

const POLL = `(function(){var t0=Date.now(),el=document.getElementById('secs');setInterval(function(){if(el)el.textContent=Math.round((Date.now()-t0)/1000)+'s'},500);
(function check(){setTimeout(function(){fetch(location.href,{headers:{accept:'application/json'},cache:'no-store',credentials:'include'}).then(function(r){if(!r.headers.get('x-boxlite-starting'))location.reload();else check()}).catch(check)},2000)})()})();`;

export function brandPageHtml(p: BrandPage): string {
  const poll = !!p.refreshSeconds;
  const body = p.bodyHtml ?? `<h1>${escapeHtml(p.heading ?? '')}</h1>\n${(p.lines ?? []).map((l) => `<p>${inline(l)}</p>`).join('\n')}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${poll ? `<noscript><meta http-equiv="refresh" content="${p.refreshSeconds}"></noscript>` : ''}<title>${escapeHtml(p.title)}</title>
<style>
:root{color-scheme:light}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;background:#fff;color:hsl(222 20% 14%);font:13px/1.6 'IBM Plex Mono',ui-monospace,'SFMono-Regular','SF Mono',Menlo,monospace;display:flex;flex-direction:column}
footer{padding:20px 24px;text-align:center;font-size:11px;color:hsl(220 9% 56%)}
footer a{color:inherit;text-decoration:none;display:inline-flex;align-items:center;gap:6px}
footer a:hover{color:hsl(222 20% 14%)}
footer b{font-weight:600;color:hsl(222 20% 30%)}
main{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:24px 24px 12vh}
.box{color:hsl(222 20% 22%);margin-bottom:22px}
.draw{stroke-dasharray:140;animation:draw 2.4s ease-in-out infinite}
.lit{animation:lit 2.4s ease-in-out .66s infinite}
@keyframes draw{0%{stroke-dashoffset:140}28%,82%{stroke-dashoffset:0}100%{stroke-dashoffset:140}}
@keyframes lit{0%,22%{fill-opacity:0}42%{fill-opacity:.18}70%,100%{fill-opacity:0}}
.label{font-size:11px;text-transform:uppercase;letter-spacing:1.8px;color:hsl(220 9% 46%)}
#secs{text-transform:none;letter-spacing:0}
h1{font-family:Inter,system-ui,sans-serif;font-size:20px;line-height:1.3;font-weight:600;letter-spacing:-.2px;margin:10px 0 8px;max-width:560px}
p{margin:0 auto 4px;color:hsl(220 9% 40%);max-width:480px}
a.btn{display:inline-block;margin-top:18px;padding:8px 14px;border:1px solid hsl(222 20% 14%);color:hsl(222 20% 14%);text-decoration:none}
a.btn:hover{background:hsl(222 20% 14%);color:#fff}
form.signin{display:flex;flex-direction:column;gap:8px;margin:18px auto 0;width:280px;max-width:100%}
form.signin input{font:inherit;padding:8px 10px;border:1px solid hsl(220 13% 82%);background:#fff;color:inherit;text-align:center}
form.signin input:focus{outline:2px solid hsl(196 100% 40% / .35);border-color:hsl(196 100% 40%)}
form.signin button{font:inherit;padding:8px 14px;border:1px solid hsl(222 20% 14%);background:hsl(222 20% 14%);color:#fff;cursor:pointer}
.or{margin-top:18px;font-size:11px;color:hsl(220 9% 56%)}
a{color:hsl(196 100% 34%)}
.hint{margin-top:28px;font-size:12px;color:hsl(220 9% 52%);max-width:480px}
.hint a{white-space:nowrap;color:inherit}
.hint a:hover{color:hsl(222 20% 14%)}
code{background:hsl(220 14% 96%);padding:1px 5px}
@media (prefers-reduced-motion: reduce){.draw{animation:none;stroke-dasharray:none}.lit{display:none}}
</style></head><body>
<main>
${box(p.tone)}
<div class="label">${escapeHtml(p.label)}${poll ? ' · <span id="secs">0s</span>' : ''}</div>
${body}
${p.action ? `<a class="btn" href="${escapeHtml(p.action.href)}">${escapeHtml(p.action.text)}</a>` : ''}
${p.hint || p.hintLink ? `<div class="hint">${p.hint ? inline(p.hint) : ''}${p.hintLink ? ` <a href="${escapeHtml(p.hintLink.href)}">${escapeHtml(p.hintLink.text)} →</a>` : ''}</div>` : ''}
</main>
<footer><a href="https://boxlite.ai" target="_blank" rel="noopener">Hosted on <svg viewBox="0 0 64 64" width="12" height="12" aria-hidden="true"><path d="${TOP}M10 22L32 34L32 56L10 44ZM32 34L54 22L54 44L32 56Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/></svg><b>BoxLite</b></a></footer>
${poll ? `<script>${POLL}</script>` : ''}
</body></html>`;
}

export function brandPage(p: BrandPage, status: number, headers: HeadersInit = {}): Response {
  const h = new Headers(headers);
  h.set('content-type', 'text/html; charset=utf-8');
  h.set('cache-control', 'no-store');
  // Marks the platform's own page, so a console screenshot (preview.ts) never keeps it as the app.
  h.set('x-boxlite-page', p.tone);
  return new Response(brandPageHtml(p), { status, headers: h });
}
