import Config from "./config";

type Level = "debug" | "info" | "warn" | "error";
const levels: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const current = levels[(Config.LOG_LEVEL as Level) || "info"] ?? 20;

function log(level: Level, msg: string, extra?: any) {
  if (levels[level] < current) return;
  if (Config.LOG_JSON) {
    const payload = { level, msg, time: new Date().toISOString(), ...(extra ?? {}) };
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(payload));
  } else {
    // eslint-disable-next-line no-console
    console.log(`[${level.toUpperCase()}] ${msg}`, extra ?? "");
  }
}

export const logger = {
  debug: (m: string, e?: any) => log("debug", m, e),
  info: (m: string, e?: any) => log("info", m, e),
  warn: (m: string, e?: any) => log("warn", m, e),
  error: (m: string, e?: any) => log("error", m, e),
};

export default logger;
