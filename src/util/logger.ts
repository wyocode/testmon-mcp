import type { Config } from "../config.js";

type Level = "debug" | "info" | "warn" | "error";
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(config: Pick<Config, "logLevel">) {
  const threshold = order[config.logLevel];
  // MCP stdio uses stdout for protocol — always log to stderr.
  const emit = (level: Level, msg: string, extra?: unknown) => {
    if (order[level] < threshold) return;
    const line =
      extra === undefined
        ? `[testmon-mcp] ${level}: ${msg}`
        : `[testmon-mcp] ${level}: ${msg} ${safeStringify(extra)}`;
    process.stderr.write(line + "\n");
  };
  return {
    debug: (m: string, e?: unknown) => emit("debug", m, e),
    info: (m: string, e?: unknown) => emit("info", m, e),
    warn: (m: string, e?: unknown) => emit("warn", m, e),
    error: (m: string, e?: unknown) => emit("error", m, e),
  };
}

export type Logger = ReturnType<typeof createLogger>;

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
