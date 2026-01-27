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
  BROWSERBOX_PORT,
  GUEST_IP,
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
  test('BROWSERBOX_PORT is a valid port number', () => {
    expect(BROWSERBOX_PORT).toBeGreaterThan(0);
    expect(BROWSERBOX_PORT).toBeLessThanOrEqual(65535);
  });

  test('BROWSERBOX_PORT is the Playwright Server default port', () => {
    expect(BROWSERBOX_PORT).toBe(3000);
  });

  test('GUEST_IP is a valid IP address', () => {
    expect(GUEST_IP).toMatch(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/);
  });

  test('GUEST_IP matches expected value', () => {
    expect(GUEST_IP).toBe('192.168.127.2');
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
