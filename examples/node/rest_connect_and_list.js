/**
 * REST API Example - Connect to a remote BoxLite server and list boxes
 *
 * Demonstrates:
 * - Creating a REST-backed runtime with Boxlite.rest()
 * - API-key authentication via ApiKeyCredential
 * - Listing existing boxes
 *
 * Prerequisites:
 *   make dev:node
 *   boxlite serve --port 8100
 */

import { JsBoxlite, BoxliteRestOptions, ApiKeyCredential } from '@boxlite-ai/boxlite';

const SERVER_URL = 'http://localhost:8100';
const API_KEY = 'local-dev-key'; // reference server accepts any non-empty bearer

async function main() {
  console.log('=== REST API: Connect and List Boxes ===\n');

  const rt = JsBoxlite.rest(new BoxliteRestOptions({
    url: SERVER_URL,
    credential: new ApiKeyCredential(API_KEY),
  }));
  console.log(`  Connected to ${SERVER_URL}`);

  const boxes = await rt.listInfo();
  console.log(`  Boxes on server: ${boxes.length}`);
  for (const info of boxes) {
    console.log(`    - ${info.id}  name=${info.name}  status=${info.state.status}`);
  }

  console.log('\n  Done');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
