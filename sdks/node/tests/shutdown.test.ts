/**
 * Integration tests for runtime shutdown functionality.
 *
 * These tests verify the shutdown() method on the Boxlite runtime.
 */

import { describe, it, expect } from 'vitest';
import { Boxlite } from '../lib/index.js';

describe('Runtime Shutdown', () => {
  it('should shutdown with default timeout', async () => {
    const runtime = Boxlite.withDefaultConfig();
    await runtime.create({ image: 'alpine:latest' });
    await runtime.shutdown();
  });

  it('should shutdown with custom timeout', async () => {
    const runtime = Boxlite.withDefaultConfig();
    await runtime.create({ image: 'alpine:latest' });
    await runtime.shutdown(5);
  });

  it('should be idempotent', async () => {
    const runtime = Boxlite.withDefaultConfig();
    await runtime.shutdown();
    await runtime.shutdown(); // Should not fail
  });

  it('should shutdown multiple boxes', async () => {
    const runtime = Boxlite.withDefaultConfig();

    // Create multiple boxes
    for (let i = 0; i < 3; i++) {
      await runtime.create({ image: 'alpine:latest' });
    }

    // Verify boxes are running
    const metrics = await runtime.metrics();
    expect(metrics.numRunningBoxes).toBeGreaterThanOrEqual(3);

    // Shutdown all
    await runtime.shutdown(10);
  });

  it('should fail operations after shutdown', async () => {
    const runtime = Boxlite.withDefaultConfig();
    await runtime.shutdown();

    await expect(runtime.create({ image: 'alpine:latest' })).rejects.toThrow();
  });

  it('should accept null timeout for default', async () => {
    const runtime = Boxlite.withDefaultConfig();
    await runtime.shutdown(null);
  });

  it('should accept -1 for infinite timeout', async () => {
    const runtime = Boxlite.withDefaultConfig();
    // Create a box first so shutdown has something to do
    await runtime.create({ image: 'alpine:latest' });
    // Use -1 (infinite timeout) - should still complete quickly with a single box
    await runtime.shutdown(-1);
  });
});
