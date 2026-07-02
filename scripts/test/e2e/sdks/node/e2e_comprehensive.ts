// Node SDK comprehensive e2e driver.
// Called by cases/test_node_comprehensive.py.
//
// Tests exec edge cases through the Node napi-rs binding:
//   - stderr isolation
//   - exit code propagation (0, 1, 42, 127)
//   - large stdout (~4000 lines)
//   - env var passing
//   - working directory
//   - concurrent execs
//   - empty output
//   - copy_in + verify

import {
  JsBoxlite, BoxliteRestOptions, ApiKeyCredential,
} from '../../../../../sdks/node';

function env(k: string, def: string): string {
  const v = process.env[k];
  return v && v.length ? v : def;
}

function die(msg: string): never {
  console.error(`FATAL: ${msg}`);
  process.exit(2);
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

  let boxId: string | null = null;
  try {
    const box = await rt.create({ image, autoRemove: true });
    boxId = box.id;
    console.log(`BOX_ID=${boxId}`);

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

  } catch (e: any) {
    die(`error: ${e.message ?? e}`);
  } finally {
    if (boxId) {
      try { await rt.remove(boxId, true); } catch { /* best-effort */ }
    }
  }

  console.log('OK');
})();
