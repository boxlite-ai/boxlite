// Demonstrate docker-like cp using the Node SDK (ESM).
// Run: node cp.js

import { JsBoxlite } from '@boxlite-ai/boxlite';
import fs from 'fs';
import path from 'path';

async function main() {
  const rt = JsBoxlite.withDefaultConfig();
  const name = `node-copy-demo-${Date.now()}`;
  const box = await rt.create({ image: 'alpine:latest' }, name);
  await box.start();

  // Prepare host dir
  const hostDir = '/tmp/boxlite_node_copy';
  fs.mkdirSync(hostDir, { recursive: true });
  fs.writeFileSync(path.join(hostDir, 'hello.txt'), 'hello from node\n');

  console.log('Copying into /app ...');
  await box.copyIn(hostDir, '/app', {});

  console.log('Listing inside box ...');
  const exec = await box.exec('ls', ['/app']);
  const res = await exec.wait();
  console.log('exit code:', res.exitCode);

  const outDir = '/tmp/boxlite_node_copy_out';
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  console.log('Copying back to host ...');
  await box.copyOut('/app', outDir, {});
  const data = fs.readFileSync(
    path.join(outDir, 'app', path.basename(hostDir), 'hello.txt'),
    'utf8'
  );
  console.log('Round-trip content:', data.trim());

  await box.stop();
  await rt.remove(name, true);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
