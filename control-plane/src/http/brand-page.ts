/**
 * The one look of every page the control plane itself answers in a browser (app origins: starting,
 * not running, private; sign-in errors). It borrows boxlite.ai's own visuals: the drifting blueprint
 * grid and the cube of 0/1 bits with its glowing core (the site's hero canvas), set on the console's
 * dark theme, with an Inter headline over IBM Plex Mono details as on the site.
 *
 * The cube's core follows the page's tone: cyan and quick while an app starts, steady while it is
 * private, still and grey when it is unavailable, red on an error. A starting page also counts the
 * seconds and checks in the background, moving on to the app the moment it answers (a meta refresh
 * stays as the fallback without JavaScript).
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
  /** One small line under everything, e.g. for the app's owner or for agents (escaped; `code` spans allowed via backticks). */
  hint?: string;
  /** A link at the end of the hint, e.g. the app in the console for its owner. */
  hintLink?: { href: string; text: string };
  /** Checks again after this many seconds (a starting app). */
  refreshSeconds?: number;
  /** Shown top right, e.g. "photos-2dph · main". */
  context?: string;
}

/** Core color (r,g,b), core brightness, rotation speed per frame. */
const TONE: Record<PageTone, { rgb: string; dot: string; lit: number; speed: number; pulse: boolean }> = {
  progress: { rgb: '0,176,240', dot: 'hsl(196 100% 47%)', lit: 1, speed: 0.02, pulse: true },
  locked: { rgb: '0,176,240', dot: 'hsl(196 100% 47%)', lit: 0.7, speed: 0.008, pulse: false },
  stopped: { rgb: '150,158,170', dot: 'hsl(221 7% 58%)', lit: 0.35, speed: 0.003, pulse: false },
  error: { rgb: '234,84,68', dot: 'hsl(5 71% 58%)', lit: 0.7, speed: 0.006, pulse: false },
};

/** `text` escaped, with `backticks` as code spans. */
const inline = (text: string) => escapeHtml(text).replace(/`([^`]+)`/g, '<code>$1</code>');

/** The site's grid and bit cube, parameterised by tone (no dependencies, ~2 KB). */
function sceneScript(t: (typeof TONE)[PageTone], poll: boolean): string {
  return `(function(){
var g=document.getElementById('grid'),c=document.getElementById('cube');if(!g||!c)return;
var gx=g.getContext('2d'),cx=c.getContext('2d'),dpr=window.devicePixelRatio||1,o=0,i=0,still=matchMedia('(prefers-reduced-motion: reduce)').matches;
function size(el,ctx){var r=el.getBoundingClientRect();el.width=r.width*dpr;el.height=r.height*dpr;ctx.setTransform(dpr,0,0,dpr,0,0);return r}
var G=size(g,gx),C=size(c,cx);addEventListener('resize',function(){G=size(g,gx);C=size(c,cx)});
function grid(){gx.clearRect(0,0,G.width,G.height);gx.strokeStyle='rgba(255,255,255,0.055)';gx.lineWidth=1;var s=40,d=o%s;
for(var x=-s+d;x<G.width+s;x+=s){gx.beginPath();gx.moveTo(x+.5,0);gx.lineTo(x+.5,G.height);gx.stroke()}
for(var y=-s+d;y<G.height+s;y+=s){gx.beginPath();gx.moveTo(0,y+.5);gx.lineTo(G.width,y+.5);gx.stroke()}}
function rot(p,X,Y,m,a){var x=p[0],y=p[1],z=p[2],q=x*a.cz-y*a.sz,w=x*a.sz+y*a.cz;x=q;y=w;q=x*a.cy-z*a.sy;var u=x*a.sy+z*a.cy;x=q;z=u;w=y*a.cx-z*a.sx;u=y*a.sx+z*a.cx;return{x:X+x*m,y:Y+w*m,z:u}}
function cube(){var W=C.width,H=C.height,X=W/2,Y=H/2,L=Math.sqrt(3),m=.525/L*Math.min(W,H);cx.clearRect(0,0,W,H);
cx.font='15px "IBM Plex Mono",ui-monospace,monospace';cx.textAlign='center';cx.textBaseline='middle';
var a={cz:Math.cos(.5*i),sz:Math.sin(.5*i),cy:Math.cos(.3*i),sy:Math.sin(.3*i),cx:Math.cos(.2*i),sx:Math.sin(.2*i)},pts=[];
for(var e=0;e<=7;e++){var u=-1+e/3.5;for(var b=0;b<=7;b++){var v=-1+b/3.5;[[1,u,v],[-1,u,v],[u,1,v],[u,-1,v],[u,v,1],[u,v,-1]].forEach(function(p,n){var k=(e+1)*131+(b+1)*419+(n+1)*7919|0,r=rot(p,X,Y,m,a);r.ch=k&1?'1':'0';pts.push(r)})}}
pts.sort(function(p,q){return p.z-q.z}).forEach(function(p){var al=Math.max(0,1.25*Math.pow((p.z+L)/(2*L),1.9)-.18);if(al>0){cx.fillStyle='rgba(255,255,255,'+(al*.85)+')';cx.fillText(p.ch,p.x,p.y)}});
var lit=${t.lit}*(${t.pulse ? '0.55+0.45*(0.5+0.5*Math.sin(i*4))' : '1'}),R=m*.3,gr=cx.createRadialGradient(X,Y,0,X,Y,R);
gr.addColorStop(0,'rgba(${t.rgb},'+(.42*lit)+')');gr.addColorStop(.6,'rgba(${t.rgb},'+(.1*lit)+')');gr.addColorStop(1,'rgba(${t.rgb},0)');cx.fillStyle=gr;cx.beginPath();cx.arc(X,Y,R,0,6.2832);cx.fill();
var s=.15,V=[[-1,-1,-1],[1,-1,-1],[1,1,-1],[-1,1,-1],[-1,-1,1],[1,-1,1],[1,1,1],[-1,1,1]].map(function(p){return rot([p[0]*s,p[1]*s,p[2]*s],X,Y,m,a)});
[[0,1,2,3],[4,5,6,7],[0,1,5,4],[3,2,6,7],[0,3,7,4],[1,2,6,5]].map(function(f){return{f:f,z:(V[f[0]].z+V[f[1]].z+V[f[2]].z+V[f[3]].z)/4}}).sort(function(p,q){return p.z-q.z}).forEach(function(F){var f=F.f;cx.save();cx.shadowBlur=22*lit;cx.shadowColor='rgba(${t.rgb},'+(.55*lit)+')';cx.fillStyle='rgba(${t.rgb},'+(.18*lit)+')';cx.strokeStyle='rgba(${t.rgb},'+(.75*lit)+')';cx.beginPath();cx.moveTo(V[f[0]].x,V[f[0]].y);for(var j=1;j<4;j++)cx.lineTo(V[f[j]].x,V[f[j]].y);cx.closePath();cx.fill();cx.stroke();cx.restore()})}
function frame(){grid();cube();if(!still){o+=.25;i+=${t.speed};requestAnimationFrame(frame)}}frame();
${
  poll
    ? `var t0=Date.now(),el=document.getElementById('secs');setInterval(function(){if(el)el.textContent=Math.round((Date.now()-t0)/1000)+'s'},500);
(function check(){setTimeout(function(){fetch(location.href,{headers:{accept:'application/json'},cache:'no-store',credentials:'include'}).then(function(r){if(!r.headers.get('x-boxlite-starting'))location.reload();else check()}).catch(check)},2000)})();`
    : ''
}
})();`;
}

export function brandPageHtml(p: BrandPage): string {
  const t = TONE[p.tone];
  const poll = !!p.refreshSeconds;
  const body =
    p.bodyHtml ??
    `<h1>${escapeHtml(p.heading ?? '')}</h1>\n${(p.lines ?? []).map((l) => `<p>${inline(l)}</p>`).join('\n')}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${poll ? `<noscript><meta http-equiv="refresh" content="${p.refreshSeconds}"></noscript>` : ''}<title>${escapeHtml(p.title)}</title>
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;background:hsl(218 17% 7%);color:#fff;font:14px/1.6 'IBM Plex Mono',ui-monospace,'SFMono-Regular','SF Mono',Menlo,monospace;overflow-x:hidden}
#grid{position:fixed;inset:0;width:100%;height:100%;z-index:0}
.vignette{position:fixed;inset:0;z-index:0;background:radial-gradient(ellipse at 50% 38%,transparent 0,hsl(218 17% 7% / .55) 55%,hsl(218 17% 7%) 85%)}
header{position:relative;z-index:1;height:60px;display:flex;align-items:center;justify-content:space-between;padding:0 30px;border-bottom:1px solid hsl(221 16% 16%);background:hsl(218 17% 7% / .7);backdrop-filter:blur(6px)}
.brand{display:flex;align-items:center;gap:10px;font-weight:600;letter-spacing:.2px}
.ctx{color:hsl(221 7% 58%);font-size:12px}
main{position:relative;z-index:1;min-height:calc(100% - 60px);display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:24px 24px 9vh}
#cube{width:300px;height:300px;max-width:70vw;max-height:70vw}
.label{margin-top:4px;font-size:11px;text-transform:uppercase;letter-spacing:2.4px;color:hsl(221 7% 62%);display:inline-flex;align-items:center;gap:10px}
.dot{width:7px;height:7px;background:${t.dot}${p.tone === 'progress' ? ';animation:pulse 1.2s infinite' : ''}}
@keyframes pulse{50%{opacity:.25}}
#secs{color:#fff;text-transform:none;letter-spacing:1px}
h1{font-family:Inter,'IBM Plex Sans',system-ui,sans-serif;font-size:clamp(26px,4vw,40px);line-height:1.15;margin:18px 0 14px;font-weight:600;letter-spacing:-.8px;max-width:760px}
p{margin:0 auto 8px;color:hsl(221 7% 72%);max-width:560px}
a.btn{display:inline-block;margin-top:22px;padding:10px 18px;background:#fff;color:hsl(218 17% 9%);font-weight:600;text-decoration:none}
a.btn:hover{opacity:.85}
a{color:hsl(196 100% 52%)}
.hint{margin-top:34px;font-size:12px;color:hsl(221 7% 55%);max-width:560px}
code{background:hsl(222 16% 12%);border:1px solid hsl(221 16% 18%);padding:1px 6px;color:#fff}
@media (prefers-reduced-motion: reduce){.dot{animation:none}}
</style></head><body>
<canvas id="grid" aria-hidden="true"></canvas><div class="vignette"></div>
<header><span class="brand"><svg width="18" height="20" viewBox="-11 -7 22 24" aria-hidden="true"><path d="M0,-6 L10,0 L0,6 L-10,0 Z" fill="rgba(0,176,240,.25)" stroke="hsl(196 100% 52%)" stroke-width="1.2"/><path d="M10,0 L10,10 L0,16 L0,6 Z" fill="rgba(0,176,240,.12)" stroke="hsl(196 100% 52%)" stroke-width="1.2"/><path d="M-10,0 L-10,10 L0,16 L0,6 Z" fill="rgba(0,176,240,.05)" stroke="hsl(196 100% 52%)" stroke-width="1.2"/></svg>BoxLite</span>${p.context ? `<span class="ctx">${escapeHtml(p.context)}</span>` : ''}</header>
<main>
<canvas id="cube" aria-hidden="true"></canvas>
<div class="label"><span class="dot"></span>${escapeHtml(p.label)}${poll ? ' · <span id="secs">0s</span>' : ''}</div>
${body}
${p.action ? `<a class="btn" href="${escapeHtml(p.action.href)}">${escapeHtml(p.action.text)}</a>` : ''}
${p.hint ? `<div class="hint">${inline(p.hint)}${p.hintLink ? ` <a href="${escapeHtml(p.hintLink.href)}">${escapeHtml(p.hintLink.text)} →</a>` : ''}</div>` : ''}
</main>
<script>${sceneScript(t, poll)}</script>
</body></html>`;
}

export function brandPage(p: BrandPage, status: number, headers: HeadersInit = {}): Response {
  const h = new Headers(headers);
  h.set('content-type', 'text/html; charset=utf-8');
  h.set('cache-control', 'no-store');
  return new Response(brandPageHtml(p), { status, headers: h });
}
