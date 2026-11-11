/**
 * Durable Postgres-backed job queue (no Redis needed at this scale).
 *
 * - `key` is a unique idempotency key: enqueuing the same key twice is a no-op,
 *   so a double-fired scheduler cannot create two daily cycles.
 * - Workers claim jobs with `FOR UPDATE SKIP LOCKED` and a lease; a crashed
 *   worker's lease expires and the job is retried after restart.
 * - Failures back off exponentially; after max_attempts the job is `dead` and
 *   an admin alert is raised.
 */
import type { Db, Tx } from "../db/index.ts";
import type { Clock } from "../shared/time.ts";
import type { Logger } from "../shared/log.ts";

export interface Job<P = Record<string, unknown>> {
  id: string;
  type: string;
  key: string;
  payload: P;
  attempts: number;
  max_attempts: number;
}

export interface EnqueueOpts {
  type: string;
  key: string;
  payload?: Record<string, unknown>;
  runAt?: Date;
  maxAttempts?: number;
}

export async function enqueue(db: Tx, clock: Clock, o: EnqueueOpts): Promise<boolean> {
  const r = await db.query(
    `INSERT INTO jobs(type, key, payload, run_at, max_attempts, created_at, updated_at)
     VALUES ($1,$2,$3::jsonb,$4,$5,$6,$6)
     ON CONFLICT (key) DO NOTHING RETURNING id`,
    [o.type, o.key, JSON.stringify(o.payload ?? {}), (o.runAt ?? clock.now()).toISOString(), o.maxAttempts ?? 8, clock.now().toISOString()],
  );
  return r.rows.length > 0;
}

/** Re-arm a recurring job: inserts if missing, or reschedules a finished one. */
export async function upsertRecurring(db: Tx, clock: Clock, o: EnqueueOpts) {
  await db.query(
    `INSERT INTO jobs(type, key, payload, run_at, max_attempts, created_at, updated_at)
     VALUES ($1,$2,$3::jsonb,$4,$5,$6,$6)
     ON CONFLICT (key) DO UPDATE SET status='queued', run_at=EXCLUDED.run_at, attempts=0, last_error=NULL, updated_at=EXCLUDED.updated_at
     WHERE jobs.status IN ('done','dead')`,
    [o.type, o.key, JSON.stringify(o.payload ?? {}), (o.runAt ?? clock.now()).toISOString(), o.maxAttempts ?? 1000, clock.now().toISOString()],
  );
}

export type Handler = (job: Job, ctx: { db: Db; log: Logger }) => Promise<unknown>;

export class RetryLater extends Error {
  public delayMs: number;
  constructor(message: string, delayMs: number) {
    super(message);
    this.delayMs = delayMs;
  }
}

export class JobRunner {
  private handlers = new Map<string, Handler>();
  private stopped = false;

  private db: Db;
  private clock: Clock;
  private log: Logger;
  private workerId: string;
  private leaseMs: any;
  private onDead?: (job: Job, err: string) => Promise<void>;
  constructor(
    db: Db,
    clock: Clock,
    log: Logger,
    workerId: string,
    leaseMs = 5 * 60_000,
    onDead?: (job: Job, err: string) => Promise<void>,
  ) {
    this.db = db;
    this.clock = clock;
    this.log = log;
    this.workerId = workerId;
    this.leaseMs = leaseMs;
    this.onDead = onDead;}

  register(type: string, h: Handler) {
    this.handlers.set(type, h);
  }

  /** Claim one runnable job (or a job whose lease expired). */
  async claim(): Promise<Job | null> {
    const now = this.clock.now();
    const types = [...this.handlers.keys()];
    if (!types.length) return null;
    const r = await this.db.tx(async (tx) => {
      const sel = await tx.query<Job & { status: string }>(
        `SELECT id, type, key, payload, attempts, max_attempts, status FROM jobs
         WHERE type = ANY($1::text[]) AND run_at <= $2
           AND (status = 'queued' OR (status = 'running' AND locked_until < $2))
         ORDER BY run_at, id LIMIT 1 FOR UPDATE SKIP LOCKED`,
        [types, now.toISOString()],
      );
      const j = sel.rows[0];
      if (!j) return null;
      await tx.query(
        `UPDATE jobs SET status='running', attempts=attempts+1, locked_by=$2, locked_until=$3, updated_at=$4 WHERE id=$1`,
        [j.id, this.workerId, new Date(now.getTime() + this.leaseMs).toISOString(), now.toISOString()],
      );
      return { ...j, attempts: j.attempts + 1 };
    });
    return r;
  }

  /** Run at most one job; returns true if a job ran. */
  async runOnce(): Promise<boolean> {
    const job = await this.claim();
    if (!job) return false;
    const h = this.handlers.get(job.type)!;
    const log = this.log.child({ job: job.type, key: job.key, attempt: job.attempts });
    try {
      const result = await h(job, { db: this.db, log });
      await this.db.query(
        `UPDATE jobs SET status='done', result=$2::jsonb, locked_by=NULL, locked_until=NULL, completed_at=$3, updated_at=$3 WHERE id=$1`,
        [job.id, JSON.stringify(result ?? null, (_k, v) => (typeof v === "bigint" ? v.toString() : v)), this.clock.now().toISOString()],
      );
      return true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const retryLater = e instanceof RetryLater;
      const dead = !retryLater && job.attempts >= job.max_attempts;
      const delay = retryLater ? e.delayMs : Math.min(60 * 60_000, 2 ** Math.min(job.attempts, 12) * 1000);
      const now = this.clock.now();
      await this.db.query(
        `UPDATE jobs SET status=$2, last_error=$3, run_at=$4, locked_by=NULL, locked_until=NULL, updated_at=$5,
           attempts = CASE WHEN $6 THEN attempts - 1 ELSE attempts END
         WHERE id=$1`,
        [job.id, dead ? "dead" : "queued", msg.slice(0, 2000), new Date(now.getTime() + delay).toISOString(), now.toISOString(), retryLater],
      );
      if (retryLater) log.debug("job deferred", { reason: msg, delayMs: delay });
      else log.warn("job failed", { error: msg, dead });
      if (dead && this.onDead) await this.onDead(job, msg).catch(() => {});
      return true;
    }
  }

  /** Drain all currently-runnable jobs (used by tests and the worker loop). */
  async drain(maxJobs = 1000): Promise<number> {
    let n = 0;
    while (n < maxJobs && (await this.runOnce())) n++;
    return n;
  }

  async loop(intervalMs = 1000) {
    while (!this.stopped) {
      try {
        const ran = await this.runOnce();
        if (!ran) await new Promise((r) => setTimeout(r, intervalMs));
      } catch (e) {
        this.log.error("job loop error", { error: e });
        await new Promise((r) => setTimeout(r, intervalMs * 5));
      }
    }
  }

  stop() {
    this.stopped = true;
  }
}
