import assert from 'node:assert/strict';
import { JsBoxlite, BoxliteRestOptions, ApiKeyCredential } from '../../../../sdks/node/dist/index.js';

const [action, hostname, port] = process.argv.slice(2);
function domain(value) {
  assert(!('name' in value), 'obsolete short name field');
  // Optional napi object fields are undefined, which JSON would omit.
  return { ...value, target: value.target ?? null };
}
const runtime = JsBoxlite.rest(new BoxliteRestOptions({
  url: process.env.BOXLITE_E2E_URL,
  credential: new ApiKeyCredential(process.env.BOXLITE_E2E_API_KEY),
  pathPrefix: process.env.BOXLITE_E2E_PREFIX,
}));
try {
  const domains = runtime.domains;
  let result;
  if (action === 'list') {
    const held = await domains.list();
    result = { ...held, domains: held.domains.map(domain), min_length: held.minLength };
  } else if (action === 'unbind') {
    assert.equal(await domains.unbind(hostname), undefined);
    result = {};
  } else {
    assert.equal(action, 'bind');
    result = domain(await domains.bind(hostname, {
      type: 'box', box: process.env.BOXLITE_E2E_BOX, port: Number(port),
    }));
  }
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  runtime.close();
}
