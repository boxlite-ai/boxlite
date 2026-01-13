/**
 * Custom Registry Example - Using alternative container registries
 *
 * Demonstrates:
 * - Configuring custom image registries for unqualified image references
 * - Registry fallback behavior (tries each in order)
 * - Using private/enterprise registries
 */

import { SimpleBox, JsBoxlite } from '@boxlite-ai/boxlite';

async function exampleCustomRegistries() {
  console.log('\n=== Example: Custom Image Registries ===');

  // Configure runtime with custom registries
  // Registries are tried in order; first successful pull wins
  const runtime = new JsBoxlite({
    imageRegistries: ['ghcr.io', 'quay.io', 'docker.io']
  });

  console.log('Configured registries: ghcr.io, quay.io, docker.io');
  console.log("When pulling 'alpine', BoxLite will try:");
  console.log('  1. ghcr.io/library/alpine');
  console.log('  2. quay.io/library/alpine');
  console.log('  3. docker.io/library/alpine');
  console.log();

  // Create a box using the configured registries
  // The 'alpine' image will be resolved through the registry list
  const box = new SimpleBox({
    image: 'alpine:latest',
    runtime: runtime,
  });

  try {
    console.log(`Creating container...`);
    const result = await box.exec('cat', '/etc/os-release');
    console.log(`Container started: ${box.id}`);
    console.log(`\nOS Info:\n${result.stdout}`);
  } finally {
    await box.stop();
  }
}

function exampleDefaultVsCustom() {
  console.log('\n=== Example: Default vs Custom Registry ===');

  // Default behavior: uses docker.io for unqualified images
  console.log('Default behavior (no custom registries):');
  console.log("  'alpine' -> docker.io/library/alpine");

  // Custom registries: tries each in order
  console.log("\nWith custom registries ['ghcr.io', 'docker.io']:");
  console.log("  'alpine' -> ghcr.io/library/alpine (try first)");
  console.log("           -> docker.io/library/alpine (fallback)");

  // Fully qualified images bypass registry resolution
  console.log('\nFully qualified images bypass registry list:');
  console.log("  'docker.io/library/alpine' -> docker.io/library/alpine (direct)");
  console.log("  'ghcr.io/foo/bar:v1' -> ghcr.io/foo/bar:v1 (direct)");
}

async function main() {
  console.log('Custom Registry Example');
  console.log('='.repeat(60));

  await exampleCustomRegistries();
  exampleDefaultVsCustom();

  console.log('\n' + '='.repeat(60));
  console.log('Key Takeaways:');
  console.log('  - Use new JsBoxlite({ imageRegistries: [...] }) to configure registries');
  console.log('  - Pass runtime to SimpleBox: new SimpleBox({ runtime, image: ... })');
  console.log('  - Registries are tried in order; first success wins');
  console.log('  - Fully qualified images (e.g., docker.io/...) bypass the list');
  console.log('  - Great for enterprise environments with private registries');
}

// Run the example
main().catch(error => {
  console.error('Error:', error);
  process.exit(1);
});
