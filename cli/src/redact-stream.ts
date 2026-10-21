import { redact } from '@microcloud/shared';
import type { Writable } from 'node:stream';

/**
 * Wraps a stream so nothing the CLI prints can carry an App key, box token or database password,
 * whatever produced it: our own lines, control-plane messages, app logs or SQL results. A proxy
 * rather than a Transform keeps writes synchronous and keeps TTY properties for readline.
 */
export function redacting(target: Writable): Writable {
  return new Proxy(target, {
    get(t, prop) {
      if (prop === 'write') {
        return (chunk: unknown, ...rest: unknown[]) => (t.write as (...a: unknown[]) => boolean)(typeof chunk === 'string' || Buffer.isBuffer(chunk) ? redact(chunk.toString()) : chunk, ...rest);
      }
      const value = Reflect.get(t, prop, t) as unknown;
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(t) : value;
    },
  });
}
