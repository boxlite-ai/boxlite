// Minimal Node SDK e2e smoke driver, called by cases/test_node_entry.py.
//
// Imports from the LOCAL sdks/node build (the repo root has a stale
// @boxlite-ai/boxlite 0.9.5 install with field-name glitches; we want
// e2e to test current code, not last release).
//
// Like the C SDK smoke, this only does create + remove — that exercises
// the napi-rs binding's URL/credential/options marshalling end to end.
// Exec stdout streaming is covered by the Python / Go / CLI smokes.

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
  } catch (e: any) {
    die(`error: ${e.message ?? e}`);
  } finally {
    if (boxId) {
      try { await rt.remove(boxId, true); } catch { /* best-effort */ }
    }
  }

  console.log('OK');
})();
