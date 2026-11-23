// BoxLite console: one page over the `boxlite serve` /v1 API.
//
// Every control calls a route the SDKs use. Views render with `h()`, which
// builds DOM nodes and sets text with textContent, so names and logs from the
// server can never inject markup. Each view returns an optional cleanup
// function that the router runs when the view is left (timers, sockets).

const main = document.getElementById('main');
const sidebar = document.getElementById('sidebar');
const toastEl = document.getElementById('toast');
document.getElementById('server-addr').textContent = location.host;

// ---------------------------------------------------------------- helpers

const SVG_NS = 'http://www.w3.org/2000/svg';
const ICONS = {
  plus: ['M12 5v14M5 12h14'],
  stop: { fill: 'M6 6h12v12H6z' },
  start: { fill: 'M7 4v16l13-8z' },
  shell: ['m5 7 5 5-5 5M12 17h7'],
  trash: ['M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3'],
  clone: ['M8 8h12v12H8z', 'M4 16V4h12'],
  back: ['M15 5l-7 7 7 7'],
  search: ['M16 16l4 4', 'M11 4.5a6.5 6.5 0 1 1 0 13a6.5 6.5 0 0 1 0-13z'],
  upload: ['M12 16V4M7 9l5-5 5 5M5 20h14'],
  download: ['M12 4v12M7 11l5 5 5-5M5 20h14'],
  restore: ['M4 12a8 8 0 1 0 2.3-5.7M4 4v5h5'],
  box: ['M12 3 20 7.5v9L12 21l-8-4.5v-9z', 'M4 7.5 12 12l8-4.5M12 12v9'],
};

function icon(name) {
  const spec = ICONS[name];
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const paths = Array.isArray(spec) ? spec : [spec.fill];
  if (!Array.isArray(spec)) svg.classList.add('fill');
  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

/** h('a.btn.primary', {href: '#/new'}, 'New') -> <a class="btn primary" href="#/new">New</a> */
function h(spec, attrs = {}, ...children) {
  const [tag, ...classes] = spec.split('.');
  const el = document.createElement(tag || 'div');
  if (classes.length) el.className = classes.join(' ');
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key === 'text') el.textContent = value;
    else if (key === 'value') el.value = value;
    else if (key === 'checked') el.checked = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

function iconButton(name, label, onclick, extra = '') {
  return h(`button.icon-btn${extra}`, { type: 'button', 'aria-label': label, title: label, onclick }, icon(name));
}

let toastTimer;
function toast(message) {
  toastEl.textContent = message;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, 3500);
}

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Call the API. JSON in, JSON out; a 401 sends the browser to sign-in. */
async function api(method, path, body, { raw = false, headers = {} } = {}) {
  const init = { method, headers: { ...headers }, credentials: 'same-origin' };
  if (body !== undefined) {
    if (body instanceof Blob || body instanceof ArrayBuffer) {
      init.body = body;
    } else {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
  }
  const res = await fetch(path, init);
  if (res.status === 401) {
    location.hash = '#/signin';
    throw new ApiError(401, 'Sign in to continue');
  }
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try { message = (await res.json()).error.message || message; } catch { /* not JSON */ }
    throw new ApiError(res.status, message);
  }
  if (raw) return res;
  if (res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

/** Run an action, toast its outcome, and rerender on success. */
async function act(promise, done, rerender) {
  try {
    await promise;
    if (done) toast(done);
    if (rerender) rerender();
  } catch (err) {
    toast(err.message);
  }
}

const enc = encodeURIComponent;
const boxPath = (id, rest = '') => `/v1/boxes/${enc(id)}${rest}`;

function bytes(n) {
  if (n === null || n === undefined) return '–';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1; }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}

function age(when) {
  const t = typeof when === 'number' ? when * 1000 : Date.parse(when);
  if (Number.isNaN(t)) return '–';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

const boxLabel = (b) => b.name || b.box_id.slice(0, 12);

function statusView(b) {
  const failed = b.status === 'failed' || (b.exit_code && b.exit_code !== 0 && b.status !== 'running');
  const cls = b.status === 'running' ? 'ok' : failed ? 'bad' : ['stopping', 'configured'].includes(b.status) ? 'busy' : '';
  let text = b.status.charAt(0).toUpperCase() + b.status.slice(1);
  if (b.status === 'stopped' && b.exit_code) text = `Exited ${b.exit_code}`;
  return h('span.status', {}, h(`span.dot${cls ? `.${cls}` : ''}`), text);
}

function startStopButton(b, after) {
  const running = b.status === 'running';
  return iconButton(running ? 'stop' : 'start', running ? 'Stop' : 'Start', () => act(
    api('POST', boxPath(b.box_id, running ? '/stop' : '/start')),
    `${running ? 'Stopped' : 'Started'} ${boxLabel(b)}`,
    after,
  ));
}

function pageHead(title, ...right) {
  return h('div.head', {}, h('h1', { text: title }), h('div.actions', {}, ...right));
}

function emptyState(message, ...extra) {
  return h('div.empty', {}, icon('box'), h('span', { text: message }), ...extra);
}

// ---------------------------------------------------------------- Boxes

function boxList() {
  let filter = 'all';
  let query = '';
  let boxes = null;
  let error = null;

  const stats = h('dl.stats');
  const body = h('div');
  const search = h('input', {
    type: 'search', placeholder: 'Filter', 'aria-label': 'Filter boxes',
    oninput: (e) => { query = e.target.value.toLowerCase(); render(); },
  });
  const seg = h('div.segmented', { role: 'group', 'aria-label': 'Status' });

  main.replaceChildren(
    pageHead('Boxes', h('a.btn.primary', { href: '#/new' }, icon('plus'), 'New')),
    stats,
    h('div.toolbar', {}, h('label.search', {}, icon('search'), search), seg),
    body,
  );

  function render() {
    seg.replaceChildren(...[['all', 'All'], ['running', 'Running'], ['stopped', 'Stopped']].map(([key, label]) =>
      h('button', { type: 'button', 'aria-pressed': String(filter === key), onclick: () => { filter = key; render(); } }, label)));
    if (error) { body.replaceChildren(h('div.alert', { text: error })); return; }
    if (!boxes) return;
    const running = boxes.filter((b) => b.status === 'running');
    stats.replaceChildren(
      h('div', {}, h('dt', { text: 'Running' }), h('dd', {}, String(running.length), h('small', { text: ` / ${boxes.length}` }))),
      h('div', {}, h('dt', { text: 'vCPU' }), h('dd', { text: String(running.reduce((n, b) => n + b.cpus, 0)) })),
      h('div', {}, h('dt', { text: 'Memory' }), h('dd', { text: bytes(running.reduce((n, b) => n + b.memory_mib, 0) * 1048576) })),
    );
    if (!boxes.length) {
      body.replaceChildren(emptyState('No boxes yet', h('span.mono', { text: '$ boxlite run alpine' }),
        h('a.btn.primary', { href: '#/new' }, icon('plus'), 'New')));
      return;
    }
    const shown = boxes.filter((b) =>
      (filter === 'all' || (filter === 'running') === (b.status === 'running'))
      && (!query || [b.name, b.image, b.box_id].join(' ').toLowerCase().includes(query)));
    body.replaceChildren(h('div.table-wrap', {}, h('table', {},
      h('thead', {}, h('tr', {},
        h('th', { text: 'Name' }), h('th', { text: 'Status' }), h('th', { text: 'Image' }),
        h('th.num', { text: 'vCPU' }), h('th.num', { text: 'Memory' }), h('th.num', { text: 'Age' }),
        h('th', {}, h('span.sr-only', { text: 'Actions' })))),
      h('tbody', {}, shown.map((b) => h('tr', {},
        h('td.name', {}, h('a', { href: `#/boxes/${enc(b.box_id)}`, text: boxLabel(b) })),
        h('td', {}, statusView(b)),
        h('td.mono', { text: b.image }),
        h('td.num.mono', { text: String(b.cpus) }),
        h('td.num.mono', { text: bytes(b.memory_mib * 1048576) }),
        h('td.num.muted', { text: age(b.created_at) }),
        h('td', {}, h('div.actions', {},
          startStopButton(b, load),
          h('a.icon-btn', { href: `#/boxes/${enc(b.box_id)}/shell`, 'aria-label': 'Shell', title: 'Shell' }, icon('shell')))),
      ))))));
  }

  async function load() {
    try { boxes = (await api('GET', '/v1/boxes')).boxes; error = null; } catch (err) { error = err.message; }
    render();
  }

  render();
  load();
  const timer = setInterval(load, 5000);
  return () => clearInterval(timer);
}

// ---------------------------------------------------------------- Box detail

const TABS = ['overview', 'logs', 'shell', 'files', 'snapshots', 'network'];

function boxDetail(id, tab) {
  let box = null;
  let confirming = false;
  let disposeTab = null;
  const head = h('div');
  const panel = h('div', { style: 'display:flex;flex-direction:column;gap:20px' });
  const tabs = h('nav.tabs', { 'aria-label': 'Box sections' }, TABS.map((t) =>
    h('a', { href: `#/boxes/${enc(id)}/${t}`, 'aria-current': t === tab ? 'page' : null, text: t.charAt(0).toUpperCase() + t.slice(1) })));
  main.replaceChildren(head, tabs, panel);

  function renderHead() {
    if (!box) return;
    head.replaceChildren(
      h('div.head', {},
        h('div.head-left', {},
          h('a.back', { href: '#/boxes', 'aria-label': 'Back to boxes' }, icon('back')),
          h('h1.mono', { text: boxLabel(box) }),
          statusView(box)),
        h('div.actions', {},
          startStopButton(box, refresh),
          iconButton('clone', 'Clone to new box', () => act(
            api('POST', boxPath(id, '/clone'), {}).then((c) => { location.hash = `#/boxes/${enc(c.box_id)}`; }),
            `Cloned ${boxLabel(box)}`)),
          iconButton('trash', 'Remove', () => { confirming = true; renderHead(); }, '.danger'))),
      confirming ? h('div.confirm', { role: 'alertdialog', 'aria-label': `Remove ${boxLabel(box)}` },
        h('span', { text: `Remove ${boxLabel(box)} and its disk?` }),
        h('div.actions', {},
          h('button.btn.sm', { type: 'button', onclick: () => { confirming = false; renderHead(); } }, 'Cancel'),
          h('button.btn.sm.danger.solid', {
            type: 'button',
            onclick: () => act(api('DELETE', `${boxPath(id)}?force=true`).then(() => { location.hash = '#/boxes'; }),
              `Removed ${boxLabel(box)}`),
          }, 'Remove'))) : '',
    );
  }

  // Overview, logs and snapshots depend on whether the box runs, so they
  // rebuild when the status changes. The other tabs keep their state (a live
  // shell above all) and render once.
  async function refresh() {
    try {
      const next = await api('GET', boxPath(id));
      const first = !box;
      const statusChanged = box && next.status !== box.status;
      box = next;
      renderHead();
      if (first || (statusChanged && ['overview', 'logs', 'snapshots'].includes(tab))) showTab();
    } catch (err) {
      head.replaceChildren(h('div.alert', { text: err.message }));
    }
  }

  function showTab() {
    if (disposeTab) disposeTab();
    disposeTab = ({ overview, logs, shell, files, snapshots, network })[tab]?.(id, box, panel, refresh) || null;
  }

  refresh();
  const timer = setInterval(refresh, 5000);
  return () => { clearInterval(timer); if (disposeTab) disposeTab(); };
}

function overview(id, box, panel) {
  const stats = h('dl.stats');
  const kv = (k, v) => [h('dt', { text: k }), h('dd', {}, v)];
  const out = box.network?.outbound;
  panel.replaceChildren(stats, h('dl.kv', {},
    kv('ID', h('span.mono', { text: box.box_id })),
    kv('Image', h('span.mono', { text: box.image })),
    kv('Size', h('span.mono', { text: `${box.cpus} vCPU · ${bytes(box.memory_mib * 1048576)}` })),
    kv('Outbound', out ? (out.mode === 'disabled' ? 'Disabled' : out.allow_net.length ? h('span.mono', { text: out.allow_net.join(', ') }) : 'Enabled') : '–'),
    kv('Inbound', box.network?.inbound?.mode === 'enabled' ? 'Enabled' : 'Off'),
    kv('Labels', Object.keys(box.labels || {}).length ? Object.entries(box.labels).map(([k, v]) => h('span.chip', { text: `${k}=${v}` })) : '–'),
    kv('Created', h('span.mono', { text: new Date(box.created_at).toLocaleString() })),
    kv('PID', h('span.mono', { text: box.pid ? String(box.pid) : '–' })),
  ));

  async function loadMetrics() {
    if (box.status !== 'running') {
      stats.replaceChildren(h('div', {}, h('dt', { text: 'Metrics' }), h('dd', {}, h('small', { text: 'Start the box to see usage' }))));
      return;
    }
    try {
      const m = await api('GET', boxPath(id, '/metrics'));
      const limit = box.memory_mib * 1048576;
      const pct = m.memory_bytes ? Math.min(100, (m.memory_bytes / limit) * 100) : 0;
      stats.replaceChildren(
        h('div', {}, h('dt', { text: 'CPU' }), h('dd', { text: m.cpu_percent === null ? '–' : `${Math.round(m.cpu_percent)}%` })),
        h('div', {}, h('dt', { text: 'Memory' }), h('dd', {}, bytes(m.memory_bytes), h('small', { text: ` / ${bytes(limit)}` })),
          h('div.bar', {}, h('span', { style: `width:${pct}%` }))),
        h('div', {}, h('dt', { text: 'Net in / out' }), h('dd', {}, bytes(m.network_bytes_received), h('small', { text: ` / ${bytes(m.network_bytes_sent)}` }))),
        h('div', {}, h('dt', { text: 'Commands' }), h('dd', { text: String(m.commands_executed_total) })),
      );
    } catch (err) {
      stats.replaceChildren(h('div', {}, h('dt', { text: 'Metrics' }), h('dd', {}, h('small', { text: err.message }))));
    }
  }
  loadMetrics();
  const timer = setInterval(loadMetrics, 5000);
  return () => clearInterval(timer);
}

const wsUrl = (path) => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${path}`;

/** Decode attach frames: binary [0x01|stdout] or [0x02|stderr]; text is JSON control. */
function attachSocket(path, { onOutput, onExit, onError, onClose }) {
  const ws = new WebSocket(wsUrl(path));
  ws.binaryType = 'arraybuffer';
  const decoder = new TextDecoder();
  ws.onmessage = (event) => {
    if (typeof event.data === 'string') {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'exit') onExit?.(msg.exit_code);
        else if (msg.type === 'error') onError?.(msg.message || 'error');
      } catch { /* ignore non-JSON */ }
      return;
    }
    const data = new Uint8Array(event.data);
    if (data.length) onOutput(data[0], data.subarray(1), decoder);
  };
  ws.onclose = (event) => onClose?.(event);
  return ws;
}

function logs(id, box, panel) {
  if (box.status !== 'running') {
    panel.replaceChildren(emptyState('Start the box to follow its output'));
    return null;
  }
  const out = h('pre.term', { 'aria-label': 'Main process output' });
  let follow = true;
  const pause = h('button.btn.sm', { type: 'button', onclick: () => { follow = !follow; pause.textContent = follow ? 'Pause' : 'Follow'; } }, 'Pause');
  panel.replaceChildren(h('div.term-bar', {}, h('span', { text: 'Main process output' }), pause), out);
  const append = (text) => {
    out.append(text);
    if (follow) out.scrollTop = out.scrollHeight;
  };
  const ws = attachSocket(boxPath(id, '/attach?stdin=0'), {
    onOutput: (_stream, data, decoder) => append(decoder.decode(data, { stream: true })),
    onExit: (code) => append(`\n[exited ${code}]\n`),
    onError: (message) => append(`\n[${message}]\n`),
    onClose: (event) => { if (event.code !== 1000 && !event.wasClean) append('\n[disconnected: another client may be attached]\n'); },
  });
  return () => ws.close();
}

function shell(id, box, panel) {
  if (!window.Terminal) {
    panel.replaceChildren(h('div.alert', { text: 'Terminal failed to load' }));
    return null;
  }
  const host = h('div.term-host');
  const state = h('span', { text: 'Connecting…' });
  panel.replaceChildren(h('div.term-bar', {}, state), host);
  const style = getComputedStyle(document.documentElement);
  const term = new window.Terminal({
    cursorBlink: true,
    fontFamily: style.getPropertyValue('--mono'),
    fontSize: 13,
    theme: { background: style.getPropertyValue('--term-bg').trim(), foreground: style.getPropertyValue('--term-fg').trim() },
  });
  const fit = new window.FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(host);
  fit.fit();

  let ws = null;
  let execId = null;
  let closed = false;
  const encoder = new TextEncoder();
  const sendResize = () => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', rows: term.rows, cols: term.cols }));
  };
  const onWindowResize = () => { fit.fit(); sendResize(); };
  window.addEventListener('resize', onWindowResize);

  (async () => {
    try {
      // Prefer bash when the image has it; fall back to sh.
      const res = await api('POST', boxPath(id, '/exec'), {
        command: '/bin/sh',
        args: ['-c', 'if command -v bash >/dev/null 2>&1; then exec bash -l; else exec sh -l; fi'],
        tty: true,
      });
      execId = res.execution_id;
      if (closed) { api('DELETE', boxPath(id, `/executions/${enc(execId)}`)).catch(() => {}); return; }
      ws = attachSocket(boxPath(id, `/executions/${enc(execId)}/attach`), {
        onOutput: (_stream, data) => term.write(data),
        onExit: (code) => { state.textContent = `Exited ${code}`; },
        onError: (message) => term.write(`\r\n[${message}]\r\n`),
        onClose: () => { if (!closed && state.textContent === 'Connected') state.textContent = 'Disconnected'; },
      });
      ws.onopen = () => { state.textContent = 'Connected'; sendResize(); term.focus(); };
      term.onData((data) => { if (ws.readyState === WebSocket.OPEN) ws.send(encoder.encode(data)); });
    } catch (err) {
      state.textContent = err.message;
    }
  })();

  function dispose() {
    closed = true;
    window.removeEventListener('resize', onWindowResize);
    if (ws) ws.close();
    if (execId) api('DELETE', boxPath(id, `/executions/${enc(execId)}`)).catch(() => {});
    term.dispose();
  }
  return dispose;
}

/** One-file ustar archive, the format PUT /files expects. */
function tarOf(name, data) {
  const header = new Uint8Array(512);
  const put = (text, offset, length) => header.set(new TextEncoder().encode(text).subarray(0, length), offset);
  const octal = (n, length) => `${n.toString(8).padStart(length - 1, '0')}\0`;
  put(name, 0, 100);
  put(octal(0o644, 8), 100, 8);
  put(octal(0, 8), 108, 8);
  put(octal(0, 8), 116, 8);
  put(octal(data.length, 12), 124, 12);
  put(octal(Math.floor(Date.now() / 1000), 12), 136, 12);
  put('        ', 148, 8);
  put('0', 156, 1);
  put('ustar\0', 257, 6);
  put('00', 263, 2);
  const sum = header.reduce((a, b) => a + b, 0);
  put(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
  const padded = Math.ceil(data.length / 512) * 512;
  const out = new Uint8Array(512 + padded + 1024);
  out.set(header, 0);
  out.set(data, 512);
  return out;
}

function files(id, box, panel) {
  const downloadPath = h('input.input.mono', { id: 'dl-path', value: '/etc/hostname', 'aria-label': 'Path to download' });
  const uploadDir = h('input.input.mono', { id: 'up-dir', value: '/root', 'aria-label': 'Directory to upload into' });
  const picker = h('input', { type: 'file', id: 'up-file', 'aria-label': 'File to upload' });
  panel.replaceChildren(h('div.grid2', {},
    h('div.field', {}, h('label', { for: 'dl-path', text: 'Download' }),
      h('div.toolbar', {}, downloadPath, iconButton('download', 'Download as tar', async () => {
        try {
          const res = await api('GET', boxPath(id, `/files?path=${enc(downloadPath.value)}`), undefined, { raw: true });
          const url = URL.createObjectURL(await res.blob());
          const name = (downloadPath.value.replace(/\/+$/, '').split('/').pop() || 'root');
          h('a', { href: url, download: `${name}.tar` }).click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        } catch (err) { toast(err.message); }
      }))),
    h('div.field', {}, h('label', { for: 'up-dir', text: 'Upload into' }),
      h('div.toolbar', {}, uploadDir, picker, iconButton('upload', 'Upload', async () => {
        const file = picker.files[0];
        if (!file) { toast('Choose a file first'); return; }
        const archive = tarOf(file.name, new Uint8Array(await file.arrayBuffer()));
        act(api('PUT', boxPath(id, `/files?path=${enc(uploadDir.value)}`), new Blob([archive]),
          { headers: { 'Content-Type': 'application/x-tar' } }),
        `Uploaded ${file.name} to ${uploadDir.value}`);
      }))),
  ));
  return null;
}

function snapshots(id, box, panel) {
  const name = h('input.input.mono', { id: 'snap-name', placeholder: 'name', 'aria-label': 'Snapshot name' });
  const list = h('div');
  const load = async () => {
    try {
      const { snapshots: items } = await api('GET', boxPath(id, '/snapshots'));
      list.replaceChildren(items.length ? h('div.table-wrap', {}, h('table', {},
        h('thead', {}, h('tr', {}, h('th', { text: 'Name' }), h('th.num', { text: 'Size' }), h('th.num', { text: 'Age' }),
          h('th', {}, h('span.sr-only', { text: 'Actions' })))),
        h('tbody', {}, items.map((s) => h('tr', {},
          h('td.name', { text: s.name }),
          h('td.num.mono', { text: bytes(s.size_bytes) }),
          h('td.num.muted', { text: age(s.created_at) }),
          h('td', {}, h('div.actions', {},
            Object.assign(iconButton('restore', box.status === 'running' ? 'Stop the box to restore' : 'Restore',
              () => act(api('POST', boxPath(id, `/snapshots/${enc(s.name)}/restore`)), `Restored ${s.name}`, load)),
            { disabled: box.status === 'running' }),
            iconButton('trash', 'Delete', () => act(api('DELETE', boxPath(id, `/snapshots/${enc(s.name)}`)), `Deleted ${s.name}`, load), '.danger'))))))))
        : emptyState('No snapshots'));
    } catch (err) {
      list.replaceChildren(h('div.alert', { text: err.message }));
    }
  };
  panel.replaceChildren(
    h('form.toolbar', {
      onsubmit: (e) => {
        e.preventDefault();
        if (!name.value.trim()) { toast('Name the snapshot'); return; }
        act(api('POST', boxPath(id, '/snapshots'), { name: name.value.trim() }), `Took ${name.value.trim()}`, () => { name.value = ''; load(); });
      },
    }, name, h('button.btn.primary', { type: 'submit' }, icon('plus'), 'Snapshot')),
    list);
  load();
  return null;
}

function network(id, box, panel) {
  const out = box.network?.outbound || { mode: 'enabled', allow_net: [] };
  const inbound = box.network?.inbound || { mode: 'disabled' };
  const outMode = h('select.input', { id: 'out-mode' },
    h('option', { value: 'enabled', selected: out.mode === 'enabled' && !out.allow_net.length, text: 'Enabled' }),
    h('option', { value: 'allow', selected: out.mode === 'enabled' && out.allow_net.length > 0, text: 'Allow list' }),
    h('option', { value: 'disabled', selected: out.mode === 'disabled', text: 'Disabled' }));
  const allow = h('input.input.mono', { id: 'out-allow', 'aria-label': 'Allowed hosts', value: out.allow_net.join(', '), placeholder: 'pypi.org, github.com' });
  const inMode = h('select.input', { id: 'in-mode' },
    h('option', { value: 'disabled', selected: inbound.mode !== 'enabled', text: 'Off' }),
    h('option', { value: 'enabled', selected: inbound.mode === 'enabled', text: 'Enabled' }));
  const syncAllow = () => { allow.hidden = outMode.value !== 'allow'; };
  outMode.addEventListener('change', syncAllow);
  syncAllow();
  panel.replaceChildren(
    h('div.grid2', { style: 'max-width:760px' },
      h('div.field', {}, h('label', { for: 'out-mode', text: 'Outbound' }), outMode, allow),
      h('div.field', {}, h('label', { for: 'in-mode', text: 'Inbound' }), inMode)),
    h('div', {}, h('button.btn.primary', {
      type: 'button',
      // Send only the directions that changed: a runtime may not support
      // updating one of them (the local backend refuses inbound updates).
      onclick: () => {
        const hosts = allow.value.split(',').map((s) => s.trim()).filter(Boolean);
        const outbound = outMode.value === 'disabled' ? { mode: 'disabled', allow_net: [] }
          : { mode: 'enabled', allow_net: outMode.value === 'allow' ? hosts : [] };
        const updates = [];
        if (JSON.stringify(outbound) !== JSON.stringify({ mode: out.mode, allow_net: out.allow_net })) {
          updates.push(api('PUT', boxPath(id, '/network/outbound'), outbound).then(() => {
            out.mode = outbound.mode;
            out.allow_net = outbound.allow_net;
          }));
        }
        if (inMode.value !== (inbound.mode === 'enabled' ? 'enabled' : 'disabled')) {
          updates.push(api('PUT', boxPath(id, '/network/inbound'), { mode: inMode.value, allow_net: [] })
            .then(() => { inbound.mode = inMode.value; }));
        }
        if (!updates.length) { toast('No changes'); return; }
        act(Promise.all(updates), 'Network updated');
      },
    }, 'Apply')));
  return null;
}

// ---------------------------------------------------------------- New box

function newBox() {
  const form = { image: 'alpine:latest', name: '', cmd: '', cpus: '1', mem: '1024', net: 'enabled', allow: '', env: [['', '']], wake: true, rm: false };
  const chips = h('div.chips');
  const cli = h('pre.term', { 'aria-label': 'Equivalent CLI command' });
  const envRows = h('div', { style: 'display:flex;flex-direction:column;gap:6px' });
  const netSeg = h('div.segmented', { role: 'radiogroup', 'aria-labelledby': 'net-label' });
  const allow = h('input.input.mono', { id: 'allow', 'aria-label': 'Allowed hosts', placeholder: 'pypi.org, github.com', oninput: (e) => { form.allow = e.target.value; preview(); } });
  const image = h('input.input.mono', { id: 'image', value: form.image, required: true, oninput: (e) => { form.image = e.target.value.trim(); renderChips(); preview(); } });
  const submit = h('button.btn.primary', { type: 'submit' }, 'Create');
  const field = (label, control, id) => h('div.field', {}, h('label', { for: id, text: label }), control);
  const select = (id, key, options) => h('select.input', { id, onchange: (e) => { form[key] = e.target.value; preview(); } },
    options.map(([v, t]) => h('option', { value: v, selected: form[key] === v, text: t })));

  const words = (s) => s.trim() ? s.trim().split(/\s+/) : [];
  const hosts = () => form.allow.split(',').map((s) => s.trim()).filter(Boolean);
  const env = () => form.env.filter(([k]) => k.trim());

  function preview() {
    const parts = ['$ boxlite run -d'];
    if (form.name) parts.push(`--name ${form.name}`);
    parts.push(`--cpus ${form.cpus} --memory ${form.mem}`);
    if (form.net === 'disabled') parts.push('--network disabled');
    if (form.net === 'allow') hosts().forEach((x) => parts.push(`--allow-net ${x}`));
    env().forEach(([k, v]) => parts.push(`-e ${k}=${v}`));
    if (form.rm) parts.push('--rm');
    if (!form.wake) parts.push('--no-auto-resume');
    parts.push([form.image, ...words(form.cmd)].join(' '));
    cli.textContent = parts.join(' \\\n  ');
    netSeg.replaceChildren(...[['enabled', 'Enabled'], ['allow', 'Allow list'], ['disabled', 'Disabled']].map(([v, t]) =>
      h('button', { type: 'button', role: 'radio', 'aria-checked': String(form.net === v), onclick: () => { form.net = v; preview(); } }, t)));
    allow.hidden = form.net !== 'allow';
  }

  function renderChips(images = renderChips.images || []) {
    renderChips.images = images;
    chips.replaceChildren(...images.slice(0, 8).map((ref) => h('button', {
      type: 'button', 'aria-pressed': String(form.image === ref),
      onclick: () => { form.image = ref; image.value = ref; renderChips(); preview(); },
    }, ref)));
  }

  function renderEnv() {
    envRows.replaceChildren(...form.env.map((pair, i) => h('div.env-row', {},
      h('input.input.mono', { 'aria-label': 'Variable name', value: pair[0], placeholder: 'NAME', oninput: (e) => { pair[0] = e.target.value; preview(); } }),
      h('input.input.mono', { 'aria-label': 'Variable value', value: pair[1], placeholder: 'value', oninput: (e) => { pair[1] = e.target.value; preview(); } }),
      i === form.env.length - 1
        ? iconButton('plus', 'Add variable', () => { form.env.push(['', '']); renderEnv(); })
        : iconButton('trash', 'Remove variable', () => { form.env.splice(i, 1); renderEnv(); preview(); }))));
  }

  async function create(e) {
    e.preventDefault();
    submit.disabled = true;
    submit.textContent = 'Creating…';
    const body = {
      image: form.image,
      cpus: Number(form.cpus),
      memory_mib: Number(form.mem),
      auto_resume: form.wake,
      network: { outbound: form.net === 'disabled' ? { mode: 'disabled' } : { mode: 'enabled', allow_net: form.net === 'allow' ? hosts() : [] } },
    };
    if (form.name) body.name = form.name;
    if (words(form.cmd).length) body.cmd = words(form.cmd);
    if (env().length) body.env = Object.fromEntries(env());
    if (form.rm) body.auto_delete = 1;
    try {
      const created = await api('POST', '/v1/boxes', body);
      await api('POST', boxPath(created.box_id, '/start'));
      toast(`Created ${boxLabel(created)}`);
      location.hash = `#/boxes/${enc(created.box_id)}`;
    } catch (err) {
      toast(err.message);
      submit.disabled = false;
      submit.textContent = 'Create';
    }
  }

  main.replaceChildren(
    h('div.head', {}, h('div.head-left', {}, h('a.back', { href: '#/boxes', 'aria-label': 'Back to boxes' }, icon('back')), h('h1', { text: 'New box' }))),
    h('div.create', {},
      h('form.form', { onsubmit: create },
        h('div.field', {}, h('label', { for: 'image', text: 'Image' }), image, chips),
        h('div.grid2', {},
          field('Name', h('input.input.mono', { id: 'name', oninput: (e) => { form.name = e.target.value.trim(); preview(); } }), 'name'),
          field('Command', h('input.input.mono', { id: 'cmd', placeholder: 'image default', oninput: (e) => { form.cmd = e.target.value; preview(); } }), 'cmd'),
          field('vCPU', select('cpus', 'cpus', [['1', '1'], ['2', '2'], ['4', '4'], ['8', '8']]), 'cpus'),
          field('Memory', select('mem', 'mem', [['512', '512 MiB'], ['1024', '1 GiB'], ['2048', '2 GiB'], ['4096', '4 GiB'], ['8192', '8 GiB']]), 'mem')),
        h('div.field', {}, h('span.label', { id: 'net-label', text: 'Outbound' }), netSeg, allow),
        h('div.field', {}, h('span.label', { text: 'Environment' }), envRows),
        h('div.checks', {},
          h('label', {}, h('input', { type: 'checkbox', checked: form.wake, onchange: (e) => { form.wake = e.target.checked; preview(); } }), 'Wake on exec'),
          h('label', {}, h('input', { type: 'checkbox', checked: form.rm, onchange: (e) => { form.rm = e.target.checked; preview(); } }), 'Remove on exit')),
        h('div.form-actions', {}, submit, h('a.btn', { href: '#/boxes' }, 'Cancel'))),
      cli));
  renderEnv();
  preview();
  api('GET', '/v1/images').then((r) => renderChips(r.images.map((i) => i.reference))).catch(() => {});
  return null;
}

// ---------------------------------------------------------------- Images

/** Fully qualify an image reference the way Docker does, so a box's
 *  `alpine:latest` matches the cache's `docker.io/library/alpine:latest`. */
function canonicalRef(ref) {
  let name = ref;
  let suffix = '';
  const at = name.indexOf('@');
  if (at >= 0) { suffix = name.slice(at); name = name.slice(0, at); }
  const slash = name.lastIndexOf('/');
  if (!suffix && name.indexOf(':', slash + 1) < 0) suffix = ':latest';
  const first = name.split('/')[0];
  const hasRegistry = name.includes('/') && (first.includes('.') || first.includes(':') || first === 'localhost');
  if (!hasRegistry) name = `docker.io/${name.includes('/') ? '' : 'library/'}${name}`;
  return name + suffix;
}

function imagesView() {
  const usage = h('div');
  const body = h('div');
  main.replaceChildren(pageHead('Images'), usage, body);

  async function load() {
    try {
      const [{ images }, { boxes }] = await Promise.all([api('GET', '/v1/images'), api('GET', '/v1/boxes')]);
      const users = (ref) => boxes.filter((b) => canonicalRef(b.image) === canonicalRef(ref)).length;
      const sized = images.some((i) => i.size_bytes !== null && i.size_bytes !== undefined);
      const total = images.reduce((n, i) => n + (i.size_bytes || 0), 0);
      const used = images.filter((i) => users(i.reference)).reduce((n, i) => n + (i.size_bytes || 0), 0);
      usage.replaceChildren(h('dl.stats', {},
        h('div', {}, h('dt', { text: 'Images' }), h('dd', { text: String(images.length) })),
        h('div', {}, h('dt', { text: 'Cached' }), h('dd', { text: sized ? bytes(total) : '–' })),
        h('div', {}, h('dt', { text: 'Unused' }), h('dd', { text: sized ? bytes(total - used) : '–' }))));
      body.replaceChildren(images.length ? h('div.table-wrap', {}, h('table', {},
        h('thead', {}, h('tr', {}, h('th', { text: 'Image' }), h('th', { text: 'ID' }), h('th.num', { text: 'Size' }),
          h('th.num', { text: 'Boxes' }), h('th.num', { text: 'Pulled' }), h('th', {}, h('span.sr-only', { text: 'Actions' })))),
        h('tbody', {}, images.map((i) => {
          const n = users(i.reference);
          const remove = iconButton('trash', n ? 'In use by a box' : 'Remove', () =>
            act(api('DELETE', `/v1/images/${enc(i.reference)}`), `Removed ${i.reference}`, load), '.danger');
          remove.disabled = n > 0;
          return h('tr', {},
            h('td.name', { text: i.reference }),
            h('td.mono.muted', { text: i.id.replace(/^sha256:/, '').slice(0, 12) }),
            h('td.num.mono', { text: bytes(i.size_bytes) }),
            h('td.num.mono', { text: n ? String(n) : '–' }),
            h('td.num.muted', { text: age(i.cached_at) }),
            h('td', {}, h('div.actions', {}, remove)));
        })))) : emptyState('No images cached'));
    } catch (err) {
      body.replaceChildren(h('div.alert', { text: err.message }));
    }
  }
  load();
  return null;
}

// ---------------------------------------------------------------- Volumes

function volumesView() {
  const name = h('input.input.mono', { id: 'vol-name', placeholder: 'name', 'aria-label': 'Volume name' });
  const body = h('div');
  // Hidden until the runtime proves it has volumes: a local runtime answers
  // the list with "not supported", and then creating one would fail too.
  const create = h('form.toolbar', {
    hidden: true,
    onsubmit: (e) => {
      e.preventDefault();
      const v = name.value.trim();
      act(api('POST', '/v1/volumes', v ? { name: v } : {}), `Created ${v || 'volume'}`, () => { name.value = ''; load(); });
    },
  }, name, h('button.btn.primary', { type: 'submit' }, icon('plus'), 'New'));
  main.replaceChildren(h('div.head', {}, h('h1', { text: 'Volumes' }), create), body);

  async function load() {
    try {
      const { volumes } = await api('GET', '/v1/volumes');
      create.hidden = false;
      body.replaceChildren(volumes.length ? h('div.table-wrap', {}, h('table', {},
        h('thead', {}, h('tr', {}, h('th', { text: 'Name' }), h('th', { text: 'ID' }), h('th.num', { text: 'Size' }),
          h('th.num', { text: 'Age' }), h('th', {}, h('span.sr-only', { text: 'Actions' })))),
        h('tbody', {}, volumes.map((v) => h('tr', {},
          h('td.name', { text: v.name }),
          h('td.mono.muted', { text: v.id }),
          h('td.num.mono', { text: bytes(v.size_bytes) }),
          h('td.num.muted', { text: age(v.created_at) }),
          h('td', {}, h('div.actions', {}, iconButton('trash', 'Remove', () =>
            act(api('DELETE', `/v1/volumes/${enc(v.id)}`), `Removed ${v.name}`, load), '.danger'))))))))
        : emptyState('No volumes'));
    } catch (err) {
      body.replaceChildren(emptyState(err.message));
    }
  }
  load();
  return null;
}

// ---------------------------------------------------------------- Access

function accessView() {
  const rows = h('dl.kv');
  const signOut = h('button.btn', { type: 'button', hidden: true, onclick: async () => {
    await api('DELETE', '/ui/session').catch(() => {});
    location.hash = '#/signin';
  } }, 'Sign out');
  main.replaceChildren(pageHead('Access', signOut), rows);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  api('GET', '/ui/session').then((s) => {
    signOut.hidden = !s.key_required;
    const row = (label, detail, state, cls) => [h('dt', { text: label }),
      h('dd', {}, h('span.status', {}, h(`span.dot.${cls}`), state), h('span.mono.muted', { text: `  ${detail}` }))];
    rows.replaceChildren(
      ...row('Listen', location.host, loopback ? 'Loopback' : 'Network', loopback ? 'ok' : 'busy'),
      ...row('Host check', loopback ? 'localhost, 127.0.0.1, [::1]' : 'off for network binds', loopback ? 'On' : 'Off', loopback ? 'ok' : 'busy'),
      ...row('Origin check', location.origin, 'On', 'ok'),
      ...row('API key', '--api-key', s.key_required ? 'Required' : 'Off', s.key_required ? 'ok' : 'busy'),
      ...row('Browser session', 'HttpOnly · SameSite=Strict', s.key_required ? 'Signed in' : 'Not needed', 'ok'),
    );
  }).catch((err) => rows.replaceChildren(h('div.alert', { text: err.message })));
  return null;
}

// ---------------------------------------------------------------- Sign in

function signInView() {
  const token = h('input.input.mono', { id: 'token', type: 'password', autocomplete: 'off', required: true });
  const error = h('span.error', { id: 'token-err', hidden: true });
  main.replaceChildren(h('div.signin', {},
    h('img', { src: '/ui/logo.svg', alt: 'BoxLite', width: 42, height: 48 }),
    h('pre.term', { style: 'min-height:0' }, '$ boxlite serve --api-key …'),
    h('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        try {
          await api('POST', '/ui/session', { token: token.value });
          location.hash = '#/boxes';
        } catch {
          error.hidden = false;
          error.textContent = 'Invalid token';
          token.setAttribute('aria-invalid', 'true');
        }
      },
    },
    h('label', { for: 'token', class: 'muted', text: 'API key' }), token, error,
    h('button.btn.primary', { type: 'submit', style: 'justify-content:center' }, 'Sign in'))));
  token.focus();
  return null;
}

// ---------------------------------------------------------------- Router

const ROUTES = [
  [/^#\/boxes\/([^/]+)(?:\/(\w+))?$/, 'boxes', (id, tab) => boxDetail(decodeURIComponent(id), TABS.includes(tab) ? tab : 'overview')],
  [/^#\/new$/, 'boxes', newBox],
  [/^#\/images$/, 'images', imagesView],
  [/^#\/volumes$/, 'volumes', volumesView],
  [/^#\/access$/, 'access', accessView],
  [/^#\/signin$/, null, signInView],
  [/^#?\/?(boxes)?$/, 'boxes', () => boxList()],
];

let dispose = null;
async function route() {
  if (dispose) { dispose(); dispose = null; }
  const hash = location.hash || '#/boxes';
  if (hash !== '#/signin') {
    try {
      const session = await (await fetch('/ui/session', { credentials: 'same-origin' })).json();
      if (!session.signed_in) { location.hash = '#/signin'; return; }
    } catch { /* server unreachable: let the view report it */ }
  }
  const match = ROUTES.map(([re, nav, view]) => [hash.match(re), nav, view]).find(([m]) => m)
    || [[], 'boxes', boxList];
  const [m, nav, view] = match;
  sidebar.hidden = nav === null;
  for (const a of sidebar.querySelectorAll('[data-nav]')) {
    if (a.dataset.nav === nav) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  dispose = view(...m.slice(1)) || null;
}

window.addEventListener('hashchange', route);
route();
