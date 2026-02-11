/**
 * Unit tests for SimpleBoxOptions interface (no VM required).
 *
 * Tests the type structure and expected properties for cmd/user options.
 */

import { describe, test, expect } from 'vitest';
import type { SimpleBoxOptions } from '../lib/simplebox.js';

describe('SimpleBoxOptions', () => {
  test('cmd defaults to undefined', () => {
    const opts: SimpleBoxOptions = {};
    expect(opts.cmd).toBeUndefined();
  });

  test('user defaults to undefined', () => {
    const opts: SimpleBoxOptions = {};
    expect(opts.user).toBeUndefined();
  });

  test('accepts cmd array', () => {
    const opts: SimpleBoxOptions = {
      image: 'docker:dind',
      cmd: ['--iptables=false'],
    };
    expect(opts.cmd).toEqual(['--iptables=false']);
  });

  test('accepts user string with uid:gid', () => {
    const opts: SimpleBoxOptions = {
      image: 'alpine:latest',
      user: '1000:1000',
    };
    expect(opts.user).toBe('1000:1000');
  });

  test('accepts cmd with multiple arguments', () => {
    const opts: SimpleBoxOptions = {
      image: 'python:slim',
      cmd: ['-m', 'http.server', '8080'],
    };
    expect(opts.cmd).toEqual(['-m', 'http.server', '8080']);
  });

  test('accepts empty cmd array', () => {
    const opts: SimpleBoxOptions = {
      image: 'alpine:latest',
      cmd: [],
    };
    expect(opts.cmd).toEqual([]);
  });

  test('accepts user with uid only', () => {
    const opts: SimpleBoxOptions = {
      image: 'alpine:latest',
      user: '1000',
    };
    expect(opts.user).toBe('1000');
  });

  test('accepts user with username', () => {
    const opts: SimpleBoxOptions = {
      image: 'nginx:latest',
      user: 'nginx',
    };
    expect(opts.user).toBe('nginx');
  });

  test('accepts security options', () => {
    const opts: SimpleBoxOptions = {
      security: {
        jailerEnabled: true,
        seccompEnabled: true,
        maxOpenFiles: 1024,
      },
    };

    expect(opts.security?.jailerEnabled).toBe(true);
    expect(opts.security?.seccompEnabled).toBe(true);
    expect(opts.security?.maxOpenFiles).toBe(1024);
  });

  test('cmd and user can be combined with other options', () => {
    const opts: SimpleBoxOptions = {
      image: 'python:slim',
      memoryMib: 1024,
      cpus: 2,
      cmd: ['--flag'],
      user: '1000:1000',
      env: { FOO: 'bar' },
      workingDir: '/app',
    };

    expect(opts.cmd).toEqual(['--flag']);
    expect(opts.user).toBe('1000:1000');
    expect(opts.memoryMib).toBe(1024);
    expect(opts.cpus).toBe(2);
  });

  test('diskSizeGb defaults to undefined', () => {
    const opts: SimpleBoxOptions = {};
    expect(opts.diskSizeGb).toBeUndefined();
  });

  test('accepts diskSizeGb number', () => {
    const opts: SimpleBoxOptions = {
      image: 'python:slim',
      diskSizeGb: 10,
    };
    expect(opts.diskSizeGb).toBe(10);
  });

  test('accepts fractional diskSizeGb', () => {
    const opts: SimpleBoxOptions = {
      image: 'alpine:latest',
      diskSizeGb: 5.5,
    };
    expect(opts.diskSizeGb).toBe(5.5);
  });

  test('diskSizeGb can be combined with other options', () => {
    const opts: SimpleBoxOptions = {
      image: 'python:slim',
      memoryMib: 1024,
      cpus: 2,
      diskSizeGb: 20,
      env: { FOO: 'bar' },
    };

    expect(opts.diskSizeGb).toBe(20);
    expect(opts.memoryMib).toBe(1024);
    expect(opts.cpus).toBe(2);
  });
});
