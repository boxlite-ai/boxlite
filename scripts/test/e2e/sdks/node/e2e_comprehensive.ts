// Node SDK comprehensive e2e driver.
// Called by cases/test_node_comprehensive.py.
//
// Exercises the napi-rs binding across exec edge cases, file I/O, and
// lifecycle. Selected per-case via BOXLITE_E2E_NODE_TEST so failures are
// reported per test on the Python side.
//
// File-I/O cases verify via copyOut (host-side byte comparison) rather than
// an exec that reads the file back, to stay independent of the Node exec
// stdout drain race (#563).

import {
  JsBoxlite, BoxliteRestOptions, ApiKeyCredential,
} from '../../../../../sdks/node';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';

function env(k: string, def: string): string {
  const v = process.env[k];
  return v && v.length ? v : def;
}

// Throw rather than process.exit() here: an immediate exit skips the
// finally block below, leaking every box this run created. The outer
// catch records the failure, cleanup runs in finally, then we exit(2).
function die(msg: string): never {
  throw new Error(msg);
}

async function drainStream(stream: any): Promise<string> {
  let result = '';
  while (true) {
    const chunk = await stream.next();
    if (chunk === null) break;
    result += chunk;
  }
  return result;
}

function sha256(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

const TEST = process.env['BOXLITE_E2E_NODE_TEST'] || 'all';

(async () => {
  const url = env('BOXLITE_E2E_URL', 'http://localhost:3000/api');
  const apiKey = env('BOXLITE_E2E_API_KEY', 'devkey');
  const prefix = env('BOXLITE_E2E_PREFIX', '');
  const image = env('BOXLITE_E2E_IMAGE', 'ghcr.io/boxlite-ai/boxlite-agent-base:20260605-p0-r3');

  const rt = JsBoxlite.rest(new BoxliteRestOptions({
    url,
    credential: new ApiKeyCredential(apiKey),
    pathPrefix: prefix,
  }));

  // These cases manage their own boxes (or need none); everything else
  // shares one box created lazily below.
  const NO_SHARED = new Set([
    'lifecycle_stop_start', 'box_info', 'two_boxes_isolated', 'list_info',
    'custom_cpus', 'get_returns_box', 'remove_idempotent', 'get_nonexistent',
    'box_name',
  ]);
  const wantsShared = TEST === 'all' || !NO_SHARED.has(TEST);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boxlite-node-e2e-'));
  const trackIds: string[] = [];

  async function newBox(autoRemove: boolean, name?: string): Promise<any> {
    const b = name
      ? await rt.create({ image, autoRemove }, name)
      : await rt.create({ image, autoRemove });
    trackIds.push(b.id);
    return b;
  }

  let box: any = null;
  let failure: string | null = null;
  try {
    if (wantsShared) {
      box = await newBox(true);
      console.log(`BOX_ID=${box.id}`);
    }

    // ── stderr isolation ──────────────────────────────────────────
    if (TEST === 'all' || TEST === 'stderr') {
      const ex = await box.exec('sh', ['-c', 'echo OUT_OK && echo ERR_OK >&2'], null, false);
      const stdout = await drainStream(await ex.stdout());
      const stderr = await drainStream(await ex.stderr());
      const rc = await ex.wait();
      if (rc.exitCode !== 0) die(`stderr test: exit=${rc.exitCode}`);
      if (!stdout.includes('OUT_OK')) die(`stderr test: stdout missing OUT_OK`);
      if (stdout.includes('ERR_OK')) die(`stderr test: stderr leaked into stdout`);
      if (!stderr.includes('ERR_OK')) die(`stderr test: stderr missing ERR_OK`);
      console.log('STDERR_ISOLATION=ok');
    }

    // ── exit codes ────────────────────────────────────────────────
    if (TEST === 'all' || TEST === 'exit_codes') {
      for (const code of [0, 1, 42, 127]) {
        const ex = await box.exec('sh', ['-c', `exit ${code}`], null, false);
        const rc = await ex.wait();
        if (rc.exitCode !== code) die(`exit code ${code}: got ${rc.exitCode}`);
      }
      console.log('EXIT_CODES=ok');
    }

    // ── signal exit code ──────────────────────────────────────────
    if (TEST === 'all' || TEST === 'signal_exit') {
      const ex = await box.exec('sh', ['-c', 'kill -9 $$'], null, false);
      const rc = await ex.wait();
      // Signal death surfaces as a negative code (-9) or 128+signal (137).
      if (rc.exitCode === 0) die(`signal_exit: expected nonzero, got 0`);
      if (!(rc.exitCode < 0 || rc.exitCode > 128)) die(`signal_exit: unexpected code ${rc.exitCode}`);
      console.log(`SIGNAL_EXIT=ok code=${rc.exitCode}`);
    }

    // ── large stdout ──────────────────────────────────────────────
    if (TEST === 'all' || TEST === 'large_stdout') {
      const ex = await box.exec('seq', ['1', '4000'], null, false);
      const stdout = await drainStream(await ex.stdout());
      const rc = await ex.wait();
      if (rc.exitCode !== 0) die(`large stdout: exit=${rc.exitCode}`);
      const lines = stdout.trim().split('\n');
      if (lines.length < 3900) die(`large stdout truncated: ${lines.length}/4000`);
      console.log(`LARGE_STDOUT=ok lines=${lines.length}`);
    }

    // ── large stderr ──────────────────────────────────────────────
    if (TEST === 'all' || TEST === 'large_stderr') {
      const ex = await box.exec('sh', ['-c', 'seq 1 4000 >&2'], null, false);
      const stderr = await drainStream(await ex.stderr());
      const rc = await ex.wait();
      if (rc.exitCode !== 0) die(`large stderr: exit=${rc.exitCode}`);
      const lines = stderr.trim().split('\n');
      if (lines.length < 3900) die(`large stderr truncated: ${lines.length}/4000`);
      console.log(`LARGE_STDERR=ok lines=${lines.length}`);
    }

    // ── env vars ──────────────────────────────────────────────────
    if (TEST === 'all' || TEST === 'env_vars') {
      const ex = await box.exec('sh', ['-c', 'echo $MY_VAR'],
        [['MY_VAR', 'node-e2e-val']], false);
      const stdout = await drainStream(await ex.stdout());
      const rc = await ex.wait();
      if (rc.exitCode !== 0) die(`env vars: exit=${rc.exitCode}`);
      if (!stdout.includes('node-e2e-val')) die(`env var not propagated: ${stdout}`);
      console.log('ENV_VARS=ok');
    }

    // ── many env vars ─────────────────────────────────────────────
    if (TEST === 'all' || TEST === 'many_env') {
      const pairs: string[][] = [];
      for (let i = 0; i < 50; i++) pairs.push([`E2E_VAR_${i}`, `val_${i}`]);
      const ex = await box.exec('sh', ['-c', 'echo "$E2E_VAR_0:$E2E_VAR_25:$E2E_VAR_49"'],
        pairs, false);
      const stdout = await drainStream(await ex.stdout());
      const rc = await ex.wait();
      if (rc.exitCode !== 0) die(`many env: exit=${rc.exitCode}`);
      if (!stdout.includes('val_0:val_25:val_49')) die(`many env not propagated: ${stdout}`);
      console.log('MANY_ENV=ok');
    }

    // ── unicode / multiline ───────────────────────────────────────
    if (TEST === 'all' || TEST === 'unicode') {
      const ex = await box.exec('printf', ['%s\\n%s\\n', 'héllo-☃', '世界'], null, false);
      const stdout = await drainStream(await ex.stdout());
      const rc = await ex.wait();
      if (rc.exitCode !== 0) die(`unicode: exit=${rc.exitCode}`);
      if (!stdout.includes('héllo-☃') || !stdout.includes('世界')) die(`unicode mangled: ${JSON.stringify(stdout)}`);
      console.log('UNICODE=ok');
    }

    // ── working directory ─────────────────────────────────────────
    if (TEST === 'all' || TEST === 'cwd') {
      const ex = await box.exec('pwd', [], null, false, undefined, undefined, '/tmp');
      const stdout = await drainStream(await ex.stdout());
      const rc = await ex.wait();
      if (rc.exitCode !== 0) die(`cwd: exit=${rc.exitCode}`);
      if (!stdout.trim().includes('/tmp')) die(`cwd not honoured: ${stdout}`);
      console.log('CWD=ok');
    }

    // ── empty output ──────────────────────────────────────────────
    if (TEST === 'all' || TEST === 'empty') {
      const ex = await box.exec('true', [], null, false);
      const stdout = await drainStream(await ex.stdout());
      const rc = await ex.wait();
      if (rc.exitCode !== 0) die(`empty: exit=${rc.exitCode}`);
      if (stdout.trim().length > 0) die(`empty: got phantom output: ${stdout}`);
      console.log('EMPTY_OUTPUT=ok');
    }

    // ── concurrent execs ──────────────────────────────────────────
    if (TEST === 'all' || TEST === 'concurrent') {
      const exA = await box.exec('sh', ['-c', 'for i in $(seq 1 50); do echo AAA_$i; done'], null, false);
      const exB = await box.exec('sh', ['-c', 'for i in $(seq 1 50); do echo BBB_$i; done'], null, false);
      const [outA, outB] = await Promise.all([
        drainStream(await exA.stdout()),
        drainStream(await exB.stdout()),
      ]);
      await Promise.all([exA.wait(), exB.wait()]);
      if (outA.includes('BBB_')) die('concurrent: B leaked into A');
      if (outB.includes('AAA_')) die('concurrent: A leaked into B');
      const countA = (outA.match(/AAA_/g) || []).length;
      const countB = (outB.match(/BBB_/g) || []).length;
      if (countA < 45) die(`concurrent: A lost lines ${countA}/50`);
      if (countB < 45) die(`concurrent: B lost lines ${countB}/50`);
      console.log('CONCURRENT=ok');
    }

    // ── stdin → exec ──────────────────────────────────────────────
    if (TEST === 'all' || TEST === 'exec_stdin') {
      const ex = await box.exec('cat', [], null, false);
      const stdin = await ex.stdin();
      await stdin.writeString('line-from-stdin\n');
      await stdin.close();
      const stdout = await drainStream(await ex.stdout());
      const rc = await ex.wait();
      if (rc.exitCode !== 0) die(`exec_stdin: exit=${rc.exitCode}`);
      if (!stdout.includes('line-from-stdin')) die(`stdin not echoed: ${JSON.stringify(stdout)}`);
      console.log('EXEC_STDIN=ok');
    }

    // ── kill a running exec ───────────────────────────────────────
    if (TEST === 'all' || TEST === 'exec_kill') {
      // Direct `sleep` (no shell fork) so the single tracked pid is the one
      // killed — a clean reap that returns from wait().
      const ex = await box.exec('sleep', ['300'], null, false);
      await ex.kill();
      const rc = await ex.wait();
      if (rc.exitCode === 0) die(`exec_kill: killed exec returned 0`);
      console.log(`EXEC_KILL=ok code=${rc.exitCode}`);
    }

    // ── signal a running exec ─────────────────────────────────────
    if (TEST === 'all' || TEST === 'exec_signal') {
      const ex = await box.exec('sleep', ['300'], null, false);
      await ex.signal(15); // SIGTERM
      const rc = await ex.wait();
      if (rc.exitCode === 0) die(`exec_signal: signalled exec returned 0`);
      console.log(`EXEC_SIGNAL=ok code=${rc.exitCode}`);
    }

    // ── tty (PTY) exec ────────────────────────────────────────────
    if (TEST === 'all' || TEST === 'exec_tty') {
      const ex = await box.exec('sh', ['-c', 'echo tty-hello'], null, true);
      const stdout = await drainStream(await ex.stdout());
      const rc = await ex.wait();
      if (rc.exitCode !== 0) die(`exec_tty: exit=${rc.exitCode}`);
      if (!stdout.includes('tty-hello')) die(`tty stdout missing: ${JSON.stringify(stdout)}`);
      console.log('EXEC_TTY=ok');
    }

    // ── resize a tty exec ─────────────────────────────────────────
    if (TEST === 'all' || TEST === 'resize_tty') {
      const ex = await box.exec('sh', ['-c', 'sleep 1; echo tty-done'], null, true);
      await ex.resizeTty(40, 100);
      const stdout = await drainStream(await ex.stdout());
      const rc = await ex.wait();
      if (rc.exitCode !== 0) die(`resize_tty: exit=${rc.exitCode}`);
      if (!stdout.includes('tty-done')) die(`resize_tty: missing output`);
      console.log('RESIZE_TTY=ok');
    }

    // ── resizeTty on a non-tty exec must reject ───────────────────
    if (TEST === 'all' || TEST === 'resize_non_tty') {
      const ex = await box.exec('sh', ['-c', 'sleep 1'], null, false);
      let threw = false;
      try { await ex.resizeTty(40, 100); } catch { threw = true; }
      await ex.wait();
      if (!threw) die(`resizeTty on a non-tty exec did not reject`);
      console.log('RESIZE_NON_TTY=ok');
    }

    // ── box.name() getter ─────────────────────────────────────────
    if (TEST === 'all' || TEST === 'box_name') {
      const name = `node-name-${Date.now()}`;
      const b = await newBox(true, name);
      // `name` is a napi getter property, not a method (like `id`).
      if (b.name !== name) die(`box.name mismatch: ${b.name} != ${name}`);
      console.log('BOX_NAME=ok');
    }

    // ── copyOut of a missing path must reject ─────────────────────
    if (TEST === 'all' || TEST === 'copyout_missing') {
      let threw = false;
      try {
        await box.copyOut('/tmp/does-not-exist-xyz', path.join(tmpDir, 'nope'));
      } catch { threw = true; }
      if (!threw) die(`copyOut of a missing path did not reject`);
      console.log('COPYOUT_MISSING=ok');
    }

    // ── file copy roundtrip (text) ────────────────────────────────
    if (TEST === 'all' || TEST === 'copy_roundtrip') {
      const src = path.join(tmpDir, 'rt-in.txt');
      const dst = path.join(tmpDir, 'rt-out.txt');
      const content = 'hello-from-node-copy\nline2\n';
      fs.writeFileSync(src, content);
      await box.copyIn(src, '/tmp/rt.txt');
      await box.copyOut('/tmp/rt.txt', dst);
      const got = fs.readFileSync(dst, 'utf-8');
      if (got !== content) die(`copy roundtrip mismatch: ${JSON.stringify(got)}`);
      console.log('COPY_ROUNDTRIP=ok');
    }

    // ── binary file integrity (all 256 byte values) ───────────────
    if (TEST === 'all' || TEST === 'copy_binary') {
      const src = path.join(tmpDir, 'bin-in');
      const dst = path.join(tmpDir, 'bin-out');
      const buf = Buffer.alloc(256);
      for (let i = 0; i < 256; i++) buf[i] = i;
      fs.writeFileSync(src, buf);
      await box.copyIn(src, '/tmp/bin');
      await box.copyOut('/tmp/bin', dst);
      const got = fs.readFileSync(dst);
      if (sha256(got) !== sha256(buf)) die(`binary mismatch: ${got.length} bytes, sha ${sha256(got)}`);
      console.log('COPY_BINARY=ok');
    }

    // ── large file integrity (1 MiB, sha256) ──────────────────────
    if (TEST === 'all' || TEST === 'copy_large') {
      const src = path.join(tmpDir, 'big-in');
      const dst = path.join(tmpDir, 'big-out');
      const buf = crypto.randomBytes(1024 * 1024);
      fs.writeFileSync(src, buf);
      await box.copyIn(src, '/tmp/big');
      await box.copyOut('/tmp/big', dst);
      const got = fs.readFileSync(dst);
      if (got.length !== buf.length) die(`large file size mismatch: ${got.length} != ${buf.length}`);
      if (sha256(got) !== sha256(buf)) die(`large file sha mismatch`);
      console.log('COPY_LARGE=ok');
    }

    // ── copy into a deeply nested dir ─────────────────────────────
    if (TEST === 'all' || TEST === 'copy_nested') {
      const src = path.join(tmpDir, 'nested-in.txt');
      const dst = path.join(tmpDir, 'nested-out.txt');
      const content = 'nested-payload\n';
      fs.writeFileSync(src, content);
      // Create the destination tree first (copyIn does not mkdir -p).
      const mk = await box.exec('mkdir', ['-p', '/tmp/a/b/c/d'], null, false);
      await mk.wait();
      await box.copyIn(src, '/tmp/a/b/c/d/f.txt');
      await box.copyOut('/tmp/a/b/c/d/f.txt', dst);
      if (fs.readFileSync(dst, 'utf-8') !== content) die(`nested copy mismatch`);
      console.log('COPY_NESTED=ok');
    }

    // ── lifecycle: stop/start preserves rootfs ────────────────────
    if (TEST === 'all' || TEST === 'lifecycle_stop_start') {
      const b = await newBox(false);
      try {
        const src = path.join(tmpDir, 'persist-in.txt');
        const dst = path.join(tmpDir, 'persist-out.txt');
        fs.writeFileSync(src, 'persist-me\n');
        await b.copyIn(src, '/root/marker.txt');
        await b.stop();
        await new Promise((r) => setTimeout(r, 1000));
        await b.start();
        await new Promise((r) => setTimeout(r, 2000));
        await b.copyOut('/root/marker.txt', dst);
        if (fs.readFileSync(dst, 'utf-8') !== 'persist-me\n') die(`rootfs data lost across stop/start`);
        console.log('LIFECYCLE_STOP_START=ok');
      } finally {
        try { await rt.remove(b.id, true); } catch { /* best-effort */ }
      }
    }

    // ── box info carries id + name ────────────────────────────────
    if (TEST === 'all' || TEST === 'box_info') {
      const name = `node-e2e-${Date.now()}`;
      const b = await newBox(true, name);
      const info = b.info();
      if (info.id !== b.id) die(`info.id mismatch: ${info.id} != ${b.id}`);
      if (info.name !== name) die(`info.name mismatch: ${info.name} != ${name}`);
      const fetched = await rt.getInfo(b.id);
      if (!fetched || fetched.id !== b.id) die(`getInfo did not return the box`);
      console.log('BOX_INFO=ok');
    }

    // ── two boxes are isolated ────────────────────────────────────
    if (TEST === 'all' || TEST === 'two_boxes_isolated') {
      const b1 = await newBox(true);
      const b2 = await newBox(true);
      const s1 = path.join(tmpDir, 'iso1.txt');
      const s2 = path.join(tmpDir, 'iso2.txt');
      const o1 = path.join(tmpDir, 'iso1-out.txt');
      const o2 = path.join(tmpDir, 'iso2-out.txt');
      fs.writeFileSync(s1, 'BOX_ONE\n');
      fs.writeFileSync(s2, 'BOX_TWO\n');
      await b1.copyIn(s1, '/root/who.txt');
      await b2.copyIn(s2, '/root/who.txt');
      await b1.copyOut('/root/who.txt', o1);
      await b2.copyOut('/root/who.txt', o2);
      if (fs.readFileSync(o1, 'utf-8') !== 'BOX_ONE\n') die(`box1 wrong data`);
      if (fs.readFileSync(o2, 'utf-8') !== 'BOX_TWO\n') die(`box2 wrong data (leak?)`);
      console.log('TWO_BOXES_ISOLATED=ok');
    }

    // ── listInfo includes a created box ───────────────────────────
    if (TEST === 'all' || TEST === 'list_info') {
      const b = await newBox(true);
      const infos = await rt.listInfo();
      if (!infos.some((i: any) => i.id === b.id)) die(`created box ${b.id} not in listInfo`);
      console.log('LIST_INFO=ok');
    }

    // ── custom cpu count is honoured in the guest ─────────────────
    if (TEST === 'all' || TEST === 'custom_cpus') {
      const b = await rt.create({ image, autoRemove: true, cpus: 2 });
      trackIds.push(b.id);
      const ex = await b.exec('nproc', [], null, false);
      const stdout = await drainStream(await ex.stdout());
      const rc = await ex.wait();
      if (rc.exitCode !== 0) die(`custom_cpus: nproc exit=${rc.exitCode}`);
      if (parseInt(stdout.trim(), 10) !== 2) die(`expected 2 cpus, guest sees ${stdout.trim()}`);
      console.log('CUSTOM_CPUS=ok');
    }

    // ── rt.get returns a usable box handle ────────────────────────
    if (TEST === 'all' || TEST === 'get_returns_box') {
      const created = await newBox(true);
      const fetched = await rt.get(created.id);
      if (!fetched) die(`rt.get returned null for ${created.id}`);
      const ex = await fetched.exec('echo', ['from-get'], null, false);
      const stdout = await drainStream(await ex.stdout());
      await ex.wait();
      if (!stdout.includes('from-get')) die(`exec via rt.get handle failed: ${JSON.stringify(stdout)}`);
      console.log('GET_RETURNS_BOX=ok');
    }

    // ── removing an already-removed box rejects ───────────────────
    if (TEST === 'all' || TEST === 'remove_idempotent') {
      const b = await rt.create({ image, autoRemove: true });
      await rt.remove(b.id, true);
      let threw = false;
      try { await rt.remove(b.id, true); } catch { threw = true; }
      if (!threw) die(`second remove did not reject`);
      console.log('REMOVE_IDEMPOTENT=ok');
    }

    // ── getInfo of a nonexistent id must not succeed ──────────────
    // The Node binding rejects with a not-found error (rather than
    // returning null); either shape is acceptable, a real box is not.
    if (TEST === 'all' || TEST === 'get_nonexistent') {
      let ok = false;
      try {
        const info = await rt.getInfo('nonexistent-box-id-xyz');
        ok = (info === null || info === undefined);
      } catch { ok = true; }
      if (!ok) die(`getInfo(nonexistent) returned a box`);
      console.log('GET_NONEXISTENT=ok');
    }

  } catch (e: any) {
    failure = e?.message ?? String(e);
  } finally {
    for (const id of trackIds) {
      try { await rt.remove(id, true); } catch { /* best-effort */ }
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  if (failure !== null) {
    console.error(`FATAL: ${failure}`);
    process.exit(2);
  }
  console.log('OK');
})();
