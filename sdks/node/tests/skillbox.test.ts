/**
 * Unit tests for SkillBox constants (no native binary required).
 */

import { describe, test, expect } from "vitest";
import {
  SKILLBOX_IMAGE,
  SKILLBOX_MEMORY_MIB,
  SKILLBOX_DISK_SIZE_GB,
  SKILLBOX_GUI_HTTP_PORT,
  SKILLBOX_GUI_HTTPS_PORT,
} from "../lib/constants.js";

describe("SkillBox constants consistency", () => {
  test("SKILLBOX_IMAGE is a valid container image ref", () => {
    expect(SKILLBOX_IMAGE).toMatch(/^[\w.-]+\/[\w.-]+\/[\w.-]+:[\w.-]+$/);
  });

  test("SKILLBOX_MEMORY_MIB is in reasonable range", () => {
    expect(SKILLBOX_MEMORY_MIB).toBeGreaterThanOrEqual(1024);
    expect(SKILLBOX_MEMORY_MIB).toBeLessThanOrEqual(16384);
  });

  test("SKILLBOX_DISK_SIZE_GB is in reasonable range", () => {
    expect(SKILLBOX_DISK_SIZE_GB).toBeGreaterThanOrEqual(1);
    expect(SKILLBOX_DISK_SIZE_GB).toBeLessThanOrEqual(100);
  });

  test("GUI ports are valid port numbers", () => {
    expect(SKILLBOX_GUI_HTTP_PORT).toBeGreaterThan(0);
    expect(SKILLBOX_GUI_HTTP_PORT).toBeLessThanOrEqual(65535);
    expect(SKILLBOX_GUI_HTTPS_PORT).toBeGreaterThan(0);
    expect(SKILLBOX_GUI_HTTPS_PORT).toBeLessThanOrEqual(65535);
  });

  test("default values match Python SDK", () => {
    expect(SKILLBOX_MEMORY_MIB).toBe(4096);
    expect(SKILLBOX_DISK_SIZE_GB).toBe(10);
  });
});
