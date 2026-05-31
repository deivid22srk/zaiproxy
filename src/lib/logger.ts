const colors = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m"
} as const;

export type LogTag =
  | "BOOT"
  | "DB"
  | "AUTH"
  | "HTTP"
  | "UPSTREAM"
  | "STREAM"
  | "HEALTH"
  | "CONFIG"
  | "TOOLS"
  | "CACHE";

const tagColors: Record<LogTag, string> = {
  BOOT: colors.green,
  DB: colors.cyan,
  AUTH: colors.magenta,
  HTTP: colors.blue,
  UPSTREAM: colors.yellow,
  STREAM: colors.cyan,
  HEALTH: colors.green,
  CONFIG: colors.gray,
  TOOLS: colors.magenta,
  CACHE: colors.blue
};

function format(tag: LogTag, level: string, message: string): string {
  const time = new Date().toISOString();
  const color = tagColors[tag];
  return `${colors.dim}${time}${colors.reset} ${color}[${tag}]${colors.reset} ${colors.dim}${level}${colors.reset} ${message}`;
}

export const logger = {
  info(tag: LogTag, message: string, meta?: unknown): void {
    console.log(format(tag, "info ", message), formatMeta(meta));
  },
  warn(tag: LogTag, message: string, meta?: unknown): void {
    console.warn(format(tag, "warn ", message), formatMeta(meta));
  },
  error(tag: LogTag, message: string, meta?: unknown): void {
    console.error(format(tag, "error", message), formatMeta(meta));
  },
  success(tag: LogTag, message: string, meta?: unknown): void {
    console.log(format(tag, "ok   ", message), formatMeta(meta));
  },
  table(tag: LogTag, title: string, rows: Array<Record<string, unknown>>): void {
    const color = tagColors[tag];
    console.log(`${color}[${tag}]${colors.reset} ${title}`);
    console.table(rows);
  }
};

export function timing(tag: LogTag, label: string): () => void {
  const start = performance.now();
  return () => {
    const ms = Math.round(performance.now() - start);
    logger.info(tag, `${label} completed in ${ms}ms`);
  };
}

function formatMeta(meta: unknown): string {
  if (meta === undefined || meta === null || meta === "") {
    return "";
  }
  if (typeof meta === "string") {
    return meta;
  }
  if (meta instanceof Error) {
    return meta.stack ?? meta.message;
  }
  try {
    return JSON.stringify(meta);
  } catch {
    return String(meta);
  }
}
