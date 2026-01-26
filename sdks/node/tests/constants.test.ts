/**
 * Unit tests for BoxLite constants (no VM required).
 *
 * Verifies constant values and consistency.
 */

import { describe, test, expect } from 'vitest';
import {
  COMPUTERBOX_IMAGE,
  COMPUTERBOX_CPUS,
  COMPUTERBOX_MEMORY_MIB,
  COMPUTERBOX_DISPLAY_NUMBER,
  COMPUTERBOX_DISPLAY_WIDTH,
  COMPUTERBOX_DISPLAY_HEIGHT,
  COMPUTERBOX_GUI_HTTP_PORT,
  COMPUTERBOX_GUI_HTTPS_PORT,
  DESKTOP_READY_TIMEOUT,
  DESKTOP_READY_RETRY_DELAY,
  BROWSERBOX_IMAGE_CHROMIUM,
  BROWSERBOX_IMAGE_FIREFOX,
  BROWSERBOX_IMAGE_WEBKIT,
  BROWSERBOX_PORT_CHROMIUM,
  BROWSERBOX_PORT_FIREFOX,
  BROWSERBOX_PORT_WEBKIT,
  DEFAULT_CPUS,
  DEFAULT_MEMORY_MIB,
} from '../lib/constants.js';

describe('ComputerBox Constants', () => {
  test('COMPUTERBOX_IMAGE is a valid container image', () => {
    // Format: [registry/]repo/image:tag (registry is optional)
    expect(COMPUTERBOX_IMAGE).toMatch(/^([\w.-]+\/)?[\w.-]+\/[\w.-]+:[\w.-]+$/);
    expect(COMPUTERBOX_IMAGE).toContain('webtop');
  });

  test('COMPUTERBOX_CPUS is a positive integer', () => {
    expect(COMPUTERBOX_CPUS).toBeGreaterThan(0);
    expect(Number.isInteger(COMPUTERBOX_CPUS)).toBe(true);
  });

  test('COMPUTERBOX_MEMORY_MIB is a reasonable value', () => {
    expect(COMPUTERBOX_MEMORY_MIB).toBeGreaterThanOrEqual(512);
    expect(COMPUTERBOX_MEMORY_MIB).toBeLessThanOrEqual(16384);
  });

  test('COMPUTERBOX_DISPLAY_NUMBER starts with colon', () => {
    expect(COMPUTERBOX_DISPLAY_NUMBER).toMatch(/^:\d+$/);
  });

  test('display dimensions are reasonable', () => {
    expect(COMPUTERBOX_DISPLAY_WIDTH).toBeGreaterThanOrEqual(640);
    expect(COMPUTERBOX_DISPLAY_HEIGHT).toBeGreaterThanOrEqual(480);
  });

  test('GUI ports are valid port numbers', () => {
    expect(COMPUTERBOX_GUI_HTTP_PORT).toBeGreaterThan(0);
    expect(COMPUTERBOX_GUI_HTTP_PORT).toBeLessThanOrEqual(65535);
    expect(COMPUTERBOX_GUI_HTTPS_PORT).toBeGreaterThan(0);
    expect(COMPUTERBOX_GUI_HTTPS_PORT).toBeLessThanOrEqual(65535);
  });
});

describe('Desktop Readiness Constants', () => {
  test('DESKTOP_READY_TIMEOUT is a positive number', () => {
    expect(DESKTOP_READY_TIMEOUT).toBeGreaterThan(0);
  });

  test('DESKTOP_READY_RETRY_DELAY is a positive number', () => {
    expect(DESKTOP_READY_RETRY_DELAY).toBeGreaterThan(0);
  });

  test('retry delay is less than timeout', () => {
    expect(DESKTOP_READY_RETRY_DELAY).toBeLessThan(DESKTOP_READY_TIMEOUT);
  });
});

describe('BrowserBox Constants', () => {
  test('browser images are valid container images', () => {
    const imagePattern = /^[\w.-]+\/[\w.-]+:[\w.-]+$/;
    expect(BROWSERBOX_IMAGE_CHROMIUM).toMatch(imagePattern);
    expect(BROWSERBOX_IMAGE_FIREFOX).toMatch(imagePattern);
    expect(BROWSERBOX_IMAGE_WEBKIT).toMatch(imagePattern);
  });

  test('browser ports are valid and distinct', () => {
    const ports = [
      BROWSERBOX_PORT_CHROMIUM,
      BROWSERBOX_PORT_FIREFOX,
      BROWSERBOX_PORT_WEBKIT,
    ];

    for (const port of ports) {
      expect(port).toBeGreaterThan(0);
      expect(port).toBeLessThanOrEqual(65535);
    }

    const uniquePorts = new Set(ports);
    expect(uniquePorts.size).toBe(ports.length);
  });

  test('chromium port is the standard CDP port', () => {
    expect(BROWSERBOX_PORT_CHROMIUM).toBe(9222);
  });
});

describe('Default Resource Limits', () => {
  test('DEFAULT_CPUS is a positive integer', () => {
    expect(DEFAULT_CPUS).toBeGreaterThan(0);
    expect(Number.isInteger(DEFAULT_CPUS)).toBe(true);
  });

  test('DEFAULT_MEMORY_MIB is a reasonable value', () => {
    expect(DEFAULT_MEMORY_MIB).toBeGreaterThanOrEqual(128);
    expect(DEFAULT_MEMORY_MIB).toBeLessThanOrEqual(4096);
  });
});

describe('Cross-SDK Consistency', () => {
  test('default resource limits match expected values', () => {
    expect(DEFAULT_CPUS).toBe(1);
    expect(DEFAULT_MEMORY_MIB).toBe(512);
  });

  test('computerbox defaults match expected values', () => {
    expect(COMPUTERBOX_CPUS).toBe(2);
    expect(COMPUTERBOX_MEMORY_MIB).toBe(2048);
    expect(COMPUTERBOX_DISPLAY_WIDTH).toBe(1024);
    expect(COMPUTERBOX_DISPLAY_HEIGHT).toBe(768);
  });
});
