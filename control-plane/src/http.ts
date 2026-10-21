import { UpstreamError } from './errors.js';

export interface JsonRequest {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
}

/**
 * fetch() wrapper for JSON APIs. A body-less POST/PUT/PATCH is sent with an explicit empty body so
 * the request carries `Content-Length: 0`: Google Frontend (in front of the BoxLite API) answers
 * 411 Length Required otherwise, before the request reaches the API.
 */
export async function requestJson<T>(service: string, req: JsonRequest): Promise<{ status: number; body: T }> {
  const headers: Record<string, string> = { accept: 'application/json', ...req.headers };
  let body: string | undefined;
  if (req.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(req.body);
  } else if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'DELETE') {
    body = '';
  }
  let res: Response;
  try {
    res = await fetch(req.url, { method: req.method, headers, body, signal: AbortSignal.timeout(req.timeoutMs ?? 30_000) });
  } catch (err) {
    throw new UpstreamError(service, 0, `${req.method} ${redactUrl(req.url)} failed: ${(err as Error).message}`);
  }
  const text = await res.text();
  let parsed: unknown = undefined;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  if (!res.ok) {
    const msg = typeof parsed === 'object' && parsed && 'message' in parsed ? String((parsed as { message: unknown }).message) : text.slice(0, 300);
    throw new UpstreamError(service, res.status, `${req.method} ${redactUrl(req.url)} → ${res.status} ${msg}`, text.slice(0, 2000));
  }
  return { status: res.status, body: parsed as T };
}

/** Query strings never carry secrets here, but strip them from messages anyway. */
export function redactUrl(url: string): string {
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
