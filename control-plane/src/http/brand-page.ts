/**
 * The one look of every page the control plane itself answers in a browser (app origins: starting,
 * not running, private; sign-in errors): the BoxLite console's dark theme and monospace type, a
 * ▸ status label, one heading, a few plain sentences, at most one button, and a quiet hint.
 * Colors are the dashboard's dark theme (dashboard/src/index.css `.dark`).
 */
import { escapeHtml } from './html.js';

export type PageTone = 'progress' | 'stopped' | 'locked' | 'error';

export interface BrandPage {
  title: string;
  tone: PageTone;
  /** The ▸ label above the heading, e.g. "Starting". */
  label: string;
  heading?: string;
  /** Paragraphs of plain text (escaped here). */
  lines?: string[];
  /** Pre-built body markup instead of heading and lines (sign-in error pages); the caller escapes it. */
  bodyHtml?: string;
  action?: { href: string; text: string };
  /** One small line under everything, e.g. for the app's owner or for agents (escaped; `code` spans allowed via backticks). */
  hint?: string;
  /** A link at the end of the hint, e.g. the app in the console for its owner. */
  hintLink?: { href: string; text: string };
  /** Reloads the page after this many seconds. */
  refreshSeconds?: number;
}

const TONE: Record<PageTone, string> = {
  progress: 'hsl(43 72% 57%)',
  stopped: 'hsl(221 7% 58%)',
  locked: 'hsl(196 100% 47%)',
  error: 'hsl(5 71% 58%)',
};

/** `text` escaped, with `backticks` as code spans. */
const inline = (text: string) => escapeHtml(text).replace(/`([^`]+)`/g, '<code>$1</code>');

export function brandPageHtml(p: BrandPage): string {
  const color = TONE[p.tone];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${p.refreshSeconds ? `<meta http-equiv="refresh" content="${p.refreshSeconds}">` : ''}<title>${escapeHtml(p.title)}</title>
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;flex-direction:column;background:hsl(218 17% 9%);color:hsl(0 0% 100%);font:14px/1.6 'IBM Plex Mono',ui-monospace,'SFMono-Regular','SF Mono',Menlo,monospace}
header{height:60px;display:flex;align-items:center;padding:0 30px;border-bottom:1px solid hsl(221 16% 20%);font-weight:600;letter-spacing:.2px}
header span{color:hsl(196 100% 47%);margin-right:8px}
main{flex:1;display:flex;align-items:flex-start;justify-content:center;padding:14vh 20px 40px}
.card{width:100%;max-width:560px;border:1px solid hsl(221 16% 20%);background:hsl(222 16% 12%);padding:28px 30px}
.label{font-size:11px;text-transform:uppercase;letter-spacing:2px;color:hsl(221 7% 58%);display:flex;align-items:center;gap:8px}
.dot{width:7px;height:7px;background:${color}${p.tone === 'progress' ? ';animation:pulse 1.4s infinite' : ''}}
@keyframes pulse{50%{opacity:.25}}
h1{font-size:20px;line-height:1.35;margin:14px 0 10px;font-weight:600;letter-spacing:-.2px}
p{margin:0 0 10px;color:hsl(221 7% 75%)}
a.btn{display:inline-block;margin-top:12px;padding:9px 16px;background:hsl(0 0% 100%);color:hsl(218 17% 9%);font-weight:600;text-decoration:none}
a.btn:hover{opacity:.85}
a{color:hsl(196 100% 47%)}
.hint{margin-top:22px;padding-top:14px;border-top:1px dashed hsl(221 16% 20%);font-size:12px;color:hsl(221 7% 58%)}
code{background:hsl(218 17% 9%);padding:1px 5px;color:hsl(0 0% 100%)}
</style></head><body>
<header><span>▣</span>BoxLite</header>
<main><div class="card">
<div class="label"><span class="dot"></span>${escapeHtml(p.label)}</div>
${p.bodyHtml ?? `<h1>${escapeHtml(p.heading ?? '')}</h1>\n${(p.lines ?? []).map((l) => `<p>${inline(l)}</p>`).join('\n')}`}
${p.action ? `<a class="btn" href="${escapeHtml(p.action.href)}">${escapeHtml(p.action.text)}</a>` : ''}
${p.hint ? `<div class="hint">${inline(p.hint)}${p.hintLink ? ` <a href="${escapeHtml(p.hintLink.href)}">${escapeHtml(p.hintLink.text)} →</a>` : ''}</div>` : ''}
</div></main></body></html>`;
}

export function brandPage(p: BrandPage, status: number, headers: HeadersInit = {}): Response {
  const h = new Headers(headers);
  h.set('content-type', 'text/html; charset=utf-8');
  h.set('cache-control', 'no-store');
  return new Response(brandPageHtml(p), { status, headers: h });
}
