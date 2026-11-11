/**
 * Structured JSON logger with secret redaction. Any key that looks like a
 * credential is masked, and any configured secret value that appears inside a
 * string is replaced, so tokens and private keys never reach logs.
 */

type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const SECRET_KEY = /(token|secret|private|password|seed|mnemonic|api[_-]?key|authorization|signature_b64|signed_tx)/i;
const secretValues = new Set<string>();

export function registerSecret(value: string | undefined | null) {
  if (value && value.length >= 8) secretValues.add(value);
}

function scrubString(s: string): string {
  let out = s;
  for (const v of secretValues) if (out.includes(v)) out = out.split(v).join("[REDACTED]");
  return out;
}

export function redact(v: unknown, depth = 0): unknown {
  if (depth > 6) return "[depth]";
  if (typeof v === "string") return scrubString(v);
  if (typeof v === "bigint") return v.toString();
  if (v instanceof Error) return { name: v.name, message: scrubString(v.message), stack: v.stack ? scrubString(v.stack) : undefined };
  if (Array.isArray(v)) return v.map((x) => redact(x, depth + 1));
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) o[k] = SECRET_KEY.test(k) ? "[REDACTED]" : redact(val, depth + 1);
    return o;
  }
  return v;
}

export interface Logger {
  debug(msg: string, ctx?: Record<string, unknown>): void;
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

export function createLogger(level: Level = "info", bindings: Record<string, unknown> = {}, sink: (line: string) => void = (l) => process.stdout.write(l + "\n")): Logger {
  const emit = (lvl: Level, msg: string, ctx?: Record<string, unknown>) => {
    if (ORDER[lvl] < ORDER[level]) return;
    sink(JSON.stringify({ t: new Date().toISOString(), level: lvl, msg: scrubString(msg), ...(redact(bindings) as object), ...(ctx ? (redact(ctx) as object) : {}) }));
  };
  return {
    debug: (m, c) => emit("debug", m, c),
    info: (m, c) => emit("info", m, c),
    warn: (m, c) => emit("warn", m, c),
    error: (m, c) => emit("error", m, c),
    child: (b) => createLogger(level, { ...bindings, ...b }, sink),
  };
}

export const silentLogger: Logger = createLogger("error", {}, () => {});
