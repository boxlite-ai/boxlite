/**
 * Runtime Shutdown Example - Graceful cleanup of all boxes.
 *
 * Demonstrates the runtime.shutdown() method:
 * - Graceful shutdown of all running boxes
 * - Custom timeout configuration
 * - Behavior after shutdown (operations fail)
 */

import { JsBoxlite } from '@boxlite-ai/boxlite';

async function main() {
  console.log('=== Runtime Shutdown Example ===\n');

  // Get the default runtime
  const runtime = JsBoxlite.withDefaultConfig();

  // Create a few boxes
  const boxes = [];
  for (let i = 0; i < 3; i++) {
    const box = await runtime.create({ image: 'alpine:latest' });
    boxes.push(box);
    console.log(`Created box ${i + 1}: ${box.id}`);
  }

  // Execute a simple command in each box
  for (let i = 0; i < boxes.length; i++) {
    const execution = await boxes[i].exec('echo', [`Hello from box ${i + 1}`]);
    const stdout = await execution.stdout();
    let line;
    while ((line = await stdout.next()) !== null) {
      console.log(`  Box ${i + 1}: ${line.trim()}`);
    }
    await execution.wait();
  }

  // Get metrics before shutdown
  const metrics = await runtime.metrics();
  console.log('\nBefore shutdown:');
  console.log(`  Running boxes: ${metrics.numRunningBoxes}`);
  console.log(`  Total commands: ${metrics.totalCommandsExecuted}`);

  // Shutdown with custom timeout (5 seconds)
  console.log('\nShutting down all boxes (5 second timeout)...');
  await runtime.shutdown(5);
  console.log('Shutdown complete!');

  // After shutdown, new operations will fail
  console.log('\nTrying to create a new box after shutdown...');
  try {
    await runtime.create({ image: 'alpine:latest' });
    console.log('ERROR: Expected this to fail!');
  } catch (e) {
    console.log(`Expected error: ${e.message}`);
  }

  console.log('\nDone!');
}

main().catch(console.error);
