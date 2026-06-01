import { logger } from "../lib/logger.js";

export type ActiveRequestKind = "chat.completion" | "response" | "completion";

export type ActiveRequestHandle = {
  id: string;
  signal: AbortSignal;
  addAlias: (alias: string | null | undefined) => void;
  complete: () => void;
};

type ActiveRequest = {
  id: string;
  kind: ActiveRequestKind;
  controller: AbortController;
  aliases: Set<string>;
  startedAt: number;
  onCancel?: () => void;
};

const activeRequests = new Map<string, ActiveRequest>();

export function createActiveRequest(options: {
  id: string;
  kind: ActiveRequestKind;
  aliases?: Array<string | null | undefined>;
  parentSignal?: AbortSignal;
  onCancel?: () => void;
}): ActiveRequestHandle {
  const controller = new AbortController();
  const entry: ActiveRequest = {
    id: options.id,
    kind: options.kind,
    controller,
    aliases: new Set([options.id]),
    startedAt: Date.now(),
    ...(options.onCancel ? { onCancel: options.onCancel } : {})
  };

  const addAlias = (alias: string | null | undefined) => {
    const normalized = normalizeId(alias);
    if (!normalized) return;
    entry.aliases.add(normalized);
    activeRequests.set(normalized, entry);
  };

  addAlias(options.id);
  options.aliases?.forEach(addAlias);

  if (options.parentSignal) {
    if (options.parentSignal.aborted) {
      controller.abort(options.parentSignal.reason);
    } else {
      options.parentSignal.addEventListener(
        "abort",
        () => cancelActiveRequest(options.id, "client_abort"),
        { once: true }
      );
    }
  }

  return {
    id: options.id,
    signal: controller.signal,
    addAlias,
    complete: () => removeActiveRequest(options.id)
  };
}

export function cancelActiveRequest(
  id: string | null | undefined,
  reason = "cancelled"
): { ok: true; id: string; kind: ActiveRequestKind } | { ok: false; id: string | null } {
  const normalized = normalizeId(id);
  if (!normalized) {
    return { ok: false, id: null };
  }

  const entry = activeRequests.get(normalized);
  if (!entry) {
    return { ok: false, id: normalized };
  }

  entry.onCancel?.();
  if (!entry.controller.signal.aborted) {
    entry.controller.abort(new Error(reason));
  }
  removeEntry(entry);
  logger.info("HTTP", "Active request cancelled", {
    id: entry.id,
    kind: entry.kind,
    reason,
    ms: Date.now() - entry.startedAt
  });
  return { ok: true, id: entry.id, kind: entry.kind };
}

export function removeActiveRequest(id: string): void {
  const normalized = normalizeId(id);
  if (!normalized) return;
  const entry = activeRequests.get(normalized);
  if (entry) {
    removeEntry(entry);
  }
}

export function isAbortError(error: unknown): boolean {
  if (!error) return false;
  if (error instanceof DOMException && error.name === "AbortError") return true;
  if (error instanceof Error) {
    return error.name === "AbortError" || /abort|cancel/i.test(error.message);
  }
  return /abort|cancel/i.test(String(error));
}

export function activeRequestCount(): number {
  return new Set(activeRequests.values()).size;
}

function removeEntry(entry: ActiveRequest): void {
  for (const alias of entry.aliases) {
    activeRequests.delete(alias);
  }
}

function normalizeId(id: string | null | undefined): string | null {
  return typeof id === "string" && id.trim() ? id.trim() : null;
}
