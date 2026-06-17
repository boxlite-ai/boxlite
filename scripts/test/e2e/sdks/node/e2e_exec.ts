// Node SDK e2e: exec with stdout capture + exit code propagation.
// Called by cases/test_node_coverage.py.

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

(async () => {
  const url = env('BOXLITE_E2E_URL', 'http://localhost:3000/api');
  const apiKey = env('BOXLITE_E2E_API_KEY', 'devkey');
  const prefix = env('BOXLITE_E2E_PREFIX', '');
  const image = env('BOXLITE_E2E_IMAGE', 'alpine:3.23');

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

    // 1. exec echo and capture stdout
    const ex1 = await box.exec('echo', ['HELLO-FROM-NODE'], null, false);
    const stdoutStream = await ex1.stdout();
    let stdout = '';
    while (true) {
      const chunk = await stdoutStream.next();
      if (chunk === null) break;
      stdout += chunk;
    }
    const r1 = await ex1.wait();
    console.log(`STDOUT=${stdout.trim()}`);
    console.log(`ECHO_EXIT=${r1.exitCode}`);

    // 2. exec with non-zero exit
    const ex2 = await box.exec('sh', ['-c', 'exit 42'], null, false);
    const r2 = await ex2.wait();
    console.log(`EXIT_CODE=${r2.exitCode}`);

  } catch (e: any) {
    die(`error: ${e.message ?? e}`);
  } finally {
    if (boxId) {
      try { await rt.remove(boxId, true); } catch { /* best-effort */ }
    }
  }

  console.log('OK');
})();
