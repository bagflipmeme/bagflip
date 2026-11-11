/**
 * Daily governance boundary math. The boundary is a wall-clock time
 * (DAILY_DECISION_HOUR:MINUTE) in TIMEZONE (Asia/Kuala_Lumpur by default).
 * The cycle a boundary opens is named by the local calendar date at the
 * boundary, e.g. the 2026-11-10 00:00 MYT decision opens cycle "2026-11-10".
 */

export interface Clock {
  now(): Date;
}
export const systemClock: Clock = { now: () => new Date() };

export class FakeClock implements Clock {
  private t: Date;
  constructor(t: Date) {
    this.t = t;}
  now() {
    return new Date(this.t);
  }
  set(t: Date | string) {
    this.t = new Date(t);
  }
  advance(ms: number) {
    this.t = new Date(this.t.getTime() + ms);
  }
}

function partsIn(tz: string, d: Date) {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const o: Record<string, string> = {};
  for (const p of f.formatToParts(d)) o[p.type] = p.value;
  return { y: +o.year!, m: +o.month!, d: +o.day!, h: +o.hour!, mi: +o.minute!, s: +o.second! };
}

/** UTC instant for a local wall-clock time in tz (handles any fixed or DST offset). */
export function zonedTimeToUtc(tz: string, y: number, m: number, d: number, h: number, mi: number): Date {
  let guess = Date.UTC(y, m - 1, d, h, mi);
  for (let i = 0; i < 3; i++) {
    const p = partsIn(tz, new Date(guess));
    const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
    const diff = asUtc - Date.UTC(y, m - 1, d, h, mi);
    if (diff === 0) break;
    guess -= diff;
  }
  return new Date(guess);
}

export function localDate(tz: string, d: Date): string {
  const p = partsIn(tz, d);
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

export interface BoundaryConfig {
  timezone: string;
  hour: number;
  minute: number;
}

/** Most recent boundary at or before `now`. */
export function previousBoundary(cfg: BoundaryConfig, now: Date): Date {
  const p = partsIn(cfg.timezone, now);
  let b = zonedTimeToUtc(cfg.timezone, p.y, p.m, p.d, cfg.hour, cfg.minute);
  if (b.getTime() > now.getTime()) {
    const y = new Date(Date.UTC(p.y, p.m - 1, p.d) - 86_400_000);
    b = zonedTimeToUtc(cfg.timezone, y.getUTCFullYear(), y.getUTCMonth() + 1, y.getUTCDate(), cfg.hour, cfg.minute);
  }
  return b;
}

/** Next boundary strictly after `now`. */
export function nextBoundary(cfg: BoundaryConfig, now: Date): Date {
  const prev = previousBoundary(cfg, now);
  const p = partsIn(cfg.timezone, prev);
  const n = new Date(Date.UTC(p.y, p.m - 1, p.d) + 86_400_000);
  return zonedTimeToUtc(cfg.timezone, n.getUTCFullYear(), n.getUTCMonth() + 1, n.getUTCDate(), cfg.hour, cfg.minute);
}

/** Cycle id opened by a boundary instant. */
export function cycleIdFor(cfg: BoundaryConfig, boundary: Date): string {
  return localDate(cfg.timezone, boundary);
}

export function formatLocal(tz: string, d: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    dateStyle: "medium",
    timeStyle: "short",
    hourCycle: "h23",
  }).format(d);
}

export const HOUR = 3_600_000;
export const MINUTE = 60_000;
