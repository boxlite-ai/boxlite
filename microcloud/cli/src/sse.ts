export interface SseEvent {
  event: string;
  data: string;
  id?: string;
}

/**
 * Minimal Server-Sent Events parser over a byte stream (text/event-stream, UTF-8).
 * Handles `\n` and `\r\n` line endings, multi-line `data:` fields, `id:` and comment lines.
 */
export async function* parseSse(body: AsyncIterable<Uint8Array>): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder();
  let buffer = '';
  let event = '';
  let data: string[] = [];
  let id: string | undefined;

  const flush = (): SseEvent | null => {
    if (data.length === 0 && event === '') return null;
    const out: SseEvent = { event: event || 'message', data: data.join('\n') };
    if (id !== undefined) out.id = id;
    event = '';
    data = [];
    return out;
  };

  const handleLine = (line: string): SseEvent | null => {
    if (line === '') return flush();
    if (line.startsWith(':')) return null;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
    else if (field === 'id') id = value;
    return null;
  };

  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      let line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      const ev = handleLine(line);
      if (ev) yield ev;
    }
  }
  buffer += decoder.decode();
  if (buffer !== '') handleLine(buffer.replace(/\r$/, ''));
  const last = flush();
  if (last) yield last;
}

export function parseJsonData<T = unknown>(ev: SseEvent): T | undefined {
  try {
    return JSON.parse(ev.data) as T;
  } catch {
    return undefined;
  }
}
