/**
 * Unit tests for ExecResult interface (no VM required).
 *
 * Tests the type structure and expected properties.
 */

import { describe, test, expect } from 'vitest';
import type { ExecResult } from '../lib/exec';

describe('ExecResult', () => {
  test('interface has required properties', () => {
    const result: ExecResult = {
      exitCode: 0,
      stdout: 'hello world\n',
      stderr: '',
    };

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('hello world\n');
    expect(result.stderr).toBe('');
  });

  test('exitCode can be non-zero', () => {
    const result: ExecResult = {
      exitCode: 127,
      stdout: '',
      stderr: 'command not found',
    };

    expect(result.exitCode).toBe(127);
  });

  test('exitCode can be negative (signal termination)', () => {
    const result: ExecResult = {
      exitCode: -9,
      stdout: '',
      stderr: 'killed',
    };

    expect(result.exitCode).toBe(-9);
  });

  test('stdout can be empty', () => {
    const result: ExecResult = {
      exitCode: 0,
      stdout: '',
      stderr: '',
    };

    expect(result.stdout).toBe('');
  });

  test('stderr can contain multiline output', () => {
    const result: ExecResult = {
      exitCode: 1,
      stdout: '',
      stderr: 'Error: file not found\n  at line 10\n  at line 20',
    };

    expect(result.stderr).toContain('Error: file not found');
    expect(result.stderr.split('\n').length).toBe(3);
  });

  test('stdout can contain multiline output', () => {
    const result: ExecResult = {
      exitCode: 0,
      stdout: 'line1\nline2\nline3',
      stderr: '',
    };

    expect(result.stdout.split('\n').length).toBe(3);
  });

  test('both stdout and stderr can have content', () => {
    const result: ExecResult = {
      exitCode: 0,
      stdout: 'output data',
      stderr: 'warning: deprecated',
    };

    expect(result.stdout).toBe('output data');
    expect(result.stderr).toBe('warning: deprecated');
  });
});
