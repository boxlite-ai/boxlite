/**
 * Example: Using a Local OCI Bundle with BoxLite
 *
 * This example demonstrates how to use a pre-exported OCI image bundle
 * instead of pulling from a registry. This is useful for:
 * - Offline/air-gapped environments
 * - Custom base images
 * - Testing with specific image versions
 * - Avoiding network latency
 *
 * Prerequisites:
 * 1. Export an OCI image using Docker/Podman:
 *    ```
 *    # Using Docker
 *    docker pull alpine:latest
 *    docker save alpine:latest -o alpine.tar
 *    mkdir alpine-bundle
 *    tar -xf alpine.tar -C alpine-bundle
 *
 *    # Or using skopeo (creates OCI layout directly)
 *    skopeo copy docker://alpine:latest oci:alpine-bundle:latest
 *    ```
 *
 * 2. The bundle should have this structure:
 *    ```
 *    alpine-bundle/
 *      oci-layout         # {"imageLayoutVersion": "1.0.0"}
 *      index.json         # Image index
 *      blobs/
 *        sha256/
 *          <manifest-hash>
 *          <config-hash>
 *          <layer-hash>...
 *    ```
 *
 * Usage:
 *    node local_oci_bundle.js /path/to/alpine-bundle
 */

import { JsBoxlite } from '@boxlite-ai/boxlite';
import * as fs from 'fs';
import * as path from 'path';

async function main() {
  // Get bundle path from command line
  const bundlePath = process.argv[2];

  if (!bundlePath) {
    console.log('Usage: node local_oci_bundle.js /path/to/oci-bundle');
    console.log('\nThis example demonstrates using a local OCI bundle with BoxLite.');
    process.exit(1);
  }

  const resolvedPath = path.resolve(bundlePath);

  // Validate the bundle structure
  if (!fs.existsSync(path.join(resolvedPath, 'oci-layout'))) {
    console.error(`Error: ${resolvedPath} is not a valid OCI bundle (missing oci-layout)`);
    process.exit(1);
  }

  if (!fs.existsSync(path.join(resolvedPath, 'index.json'))) {
    console.error(`Error: ${resolvedPath} is not a valid OCI bundle (missing index.json)`);
    process.exit(1);
  }

  console.log(`Using local OCI bundle: ${resolvedPath}`);

  // Initialize the runtime with default settings (~/.boxlite)
  const runtime = JsBoxlite.withDefaultConfig();

  // Create a box using the local OCI bundle
  const box = await runtime.create({
    rootfs_path: resolvedPath, // Use local bundle instead of image
    cpus: 1,
    memory_mib: 256,
  });

  console.log(`Box created: ${box.id}`);

  try {
    // Run a simple command
    console.log('\n/etc/os-release:');
    const result = await box.exec('cat', ['/etc/os-release']);
    const stdout = await result.stdout();
    let line;
    while ((line = await stdout.next()) !== null) {
      console.log(line.trim());
    }
    await result.wait();

    // Show kernel info
    console.log('\nKernel info:');
    const unameResult = await box.exec('uname', ['-a']);
    const unameStdout = await unameResult.stdout();
    while ((line = await unameStdout.next()) !== null) {
      console.log(line.trim());
    }
    await unameResult.wait();
  } finally {
    // Clean up
    await box.stop();
    console.log('\nBox cleaned up successfully!');
  }
}

main().catch(console.error);
