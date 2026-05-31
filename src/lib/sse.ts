export type SseEvent = {
  event?: string;
  data: string;
};

export async function* parseSse(stream: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      let boundary = findBoundary(buffer);
      while (boundary >= 0) {
        const raw = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + (buffer[boundary] === "\r" ? 4 : 2));
        const event = parseEvent(raw);
        if (event) {
          yield event;
        }
        boundary = findBoundary(buffer);
      }
    }

    buffer += decoder.decode();
    const event = parseEvent(buffer);
    if (event) {
      yield event;
    }
  } finally {
    reader.releaseLock();
  }
}

export function encodeSse(data: unknown): Uint8Array {
  const payload = typeof data === "string" ? data : JSON.stringify(data);
  return new TextEncoder().encode(`data: ${payload}\n\n`);
}

function findBoundary(buffer: string): number {
  const unix = buffer.indexOf("\n\n");
  const win = buffer.indexOf("\r\n\r\n");
  if (unix < 0) {
    return win;
  }
  if (win < 0) {
    return unix;
  }
  return Math.min(unix, win);
}

function parseEvent(raw: string): SseEvent | null {
  if (!raw.trim()) {
    return null;
  }

  let event: string | undefined;
  const data: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim();
    } else if (line.startsWith("data:")) {
      data.push(line.slice("data:".length).trimStart());
    }
  }

  if (data.length === 0) {
    return null;
  }
  return event ? { event, data: data.join("\n") } : { data: data.join("\n") };
}
