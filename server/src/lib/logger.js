const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

/**
 * Tiny structured JSON logger. Render's log viewer indexes JSON lines,
 * so every entry is one line: {"t":..., "level":..., "msg":..., ...fields}.
 * Secrets never belong in `fields` — callers pass shop domains and ids only.
 */
export function createLogger(level = 'info', sink = console) {
  const min = LEVELS[level] ?? LEVELS.info;

  const write = (lvl, msg, fields) => {
    if (LEVELS[lvl] < min) return;
    const entry = { t: new Date().toISOString(), level: lvl, msg };
    if (fields) {
      for (const [k, v] of Object.entries(fields)) {
        entry[k] = v instanceof Error ? { name: v.name, message: v.message, stack: v.stack } : v;
      }
    }
    const line = JSON.stringify(entry);
    if (lvl === 'error') sink.error(line);
    else if (lvl === 'warn') sink.warn(line);
    else sink.log(line);
  };

  return {
    debug: (msg, f) => write('debug', msg, f),
    info: (msg, f) => write('info', msg, f),
    warn: (msg, f) => write('warn', msg, f),
    error: (msg, f) => write('error', msg, f),
  };
}
