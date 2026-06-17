// Node SDK e2e: copy in/out round-trip.
// Called by cases/test_node_coverage.py.

import {
  JsBoxlite, BoxliteRestOptions, ApiKeyCredential,
} from '../../../../../sdks/node';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

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

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boxlite-node-e2e-'));
  const uploadPath = path.join(tmpDir, 'upload.txt');
  const downloadPath = path.join(tmpDir, 'download.txt');
  const content = 'hello-from-node-copy-e2e\n';

  let boxId: string | null = null;
  try {
    fs.writeFileSync(uploadPath, content);

    const box = await rt.create({ image, autoRemove: true });
    boxId = box.id;
    console.log(`BOX_ID=${boxId}`);

    // copy in
    await box.copyIn(uploadPath, '/tmp/e2e-copy-test.txt');
    console.log('COPY_IN=ok');

    // verify via exec
    const ex = await box.exec('cat', ['/tmp/e2e-copy-test.txt'], null, false);
    const stdoutStream = await ex.stdout();
    let stdout = '';
    while (true) {
      const chunk = await stdoutStream.next();
      if (chunk === null) break;
      stdout += chunk;
    }
    await ex.wait();

    if (stdout.trim() === content.trim()) {
      console.log('CONTENT_MATCH=ok');
    } else {
      die(`content mismatch: got ${JSON.stringify(stdout)}, want ${JSON.stringify(content)}`);
    }

    // copy out
    await box.copyOut('/tmp/e2e-copy-test.txt', downloadPath);
    const downloaded = fs.readFileSync(downloadPath, 'utf-8');
    if (downloaded.trim() === content.trim()) {
      console.log('COPY_OUT=ok');
    } else {
      die(`copy out mismatch: got ${JSON.stringify(downloaded)}`);
    }

  } catch (e: any) {
    die(`error: ${e.message ?? e}`);
  } finally {
    if (boxId) {
      try { await rt.remove(boxId, true); } catch { /* best-effort */ }
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log('OK');
})();
