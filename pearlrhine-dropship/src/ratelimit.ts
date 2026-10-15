/** Einfaches Fenster-Rate-Limit im Speicher (eine Instanz, reicht für diesen Betrieb). */
const windows = new Map<string, { start: number; count: number }>();

export function rateLimit(key: string, perMinute: number, now = Date.now()): boolean {
  const w = windows.get(key);
  if (!w || now - w.start >= 60_000) {
    windows.set(key, { start: now, count: 1 });
    return true;
  }
  w.count++;
  return w.count <= perMinute;
}

export const resetRateLimits = () => windows.clear();
