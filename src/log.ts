// Minimal logger. CLOUDFRIEND_LOG=silent turns it off (tests), CLOUDFRIEND_LOG=debug adds detail.
type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level | "silent", number> = { debug: 0, info: 1, warn: 2, error: 3, silent: 4 };

function threshold(): number {
  return ORDER[(process.env.CLOUDFRIEND_LOG as Level) ?? "info"] ?? ORDER.info;
}

function write(level: Level, msg: string, fields?: Record<string, unknown>): void {
  if (ORDER[level] < threshold()) return;
  const extra = fields
    ? " " + Object.entries(fields).map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`).join(" ")
    : "";
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${msg}${extra}`;
  (level === "error" || level === "warn" ? console.error : console.log)(line);
}

export const log = {
  debug: (msg: string, f?: Record<string, unknown>) => write("debug", msg, f),
  info: (msg: string, f?: Record<string, unknown>) => write("info", msg, f),
  warn: (msg: string, f?: Record<string, unknown>) => write("warn", msg, f),
  error: (msg: string, f?: Record<string, unknown>) => write("error", msg, f),
};

export const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err));
