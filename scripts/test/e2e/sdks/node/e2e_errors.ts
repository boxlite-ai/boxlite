// Node SDK e2e: error typing — bogus image + nonexistent box.
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

  const rt = JsBoxlite.rest(new BoxliteRestOptions({
    url,
    credential: new ApiKeyCredential(apiKey),
    pathPrefix: prefix,
  }));

  // 1. create with bogus image → should error, not 500
  try {
    await rt.create({ image: 'this-image-does-not-exist:0.0.0' });
    die('bogus image create should have thrown');
  } catch (e: any) {
    const msg = (e.message ?? String(e)).toLowerCase();
    // Any typed error is fine; 500/internal is the bug
    if (msg.includes('500') && msg.includes('internal')) {
      die(`bogus image leaked 500: ${e.message}`);
    }
    console.log('IMAGE_ERROR=caught');
  }

  // 2. get nonexistent box → should error
  try {
    const box = await rt.get('00000000-0000-0000-0000-000000000000');
    if (box === null || box === undefined) {
      console.log('NOT_FOUND=null');
    } else {
      die('get nonexistent box should have returned null or thrown');
    }
  } catch (e: any) {
    const msg = (e.message ?? String(e)).toLowerCase();
    if (msg.includes('500') && msg.includes('internal')) {
      die(`get nonexistent leaked 500: ${e.message}`);
    }
    console.log('NOT_FOUND=caught');
  }

  console.log('OK');
})();
