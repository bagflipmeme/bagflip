/**
 * Telegram users, NEP-413 wallet linking and continuous votes.
 *
 * A Telegram ID is never proof of wallet ownership. A wallet is linked only
 * after the backend verifies a NEP-413 signature over a unique, expiring,
 * single-use challenge that names the Telegram user and this app, AND the
 * signing key is a full-access key of that account on chain.
 */
import { randomBytes } from "node:crypto";
import type { Db, Tx } from "../db/index.ts";
import type { Clock } from "../shared/time.ts";
import type { Config } from "../shared/config.ts";
import type { NearChain } from "../near/chain.ts";
import { verifyNep413Signature } from "../near/nep413.ts";
import type { Choice } from "./engine.ts";

export interface UserRow {
  id: string;
  telegram_id: string;
  username: string | null;
  first_name: string | null;
}

export async function upsertUser(db: Tx, tg: { id: number; username?: string; first_name?: string }): Promise<UserRow> {
  const r = await db.query<UserRow>(
    `INSERT INTO users(telegram_id, username, first_name) VALUES ($1,$2,$3)
     ON CONFLICT (telegram_id) DO UPDATE SET username = EXCLUDED.username, first_name = EXCLUDED.first_name
     RETURNING id, telegram_id, username, first_name`,
    [tg.id, tg.username ?? null, tg.first_name ?? null],
  );
  return r.rows[0]!;
}

export interface Challenge {
  id: string;
  nonceB64: string;
  message: string;
  recipient: string;
  expiresAt: Date;
}

export async function createChallenge(db: Db, clock: Clock, cfg: Config, user: UserRow): Promise<Challenge> {
  // Throttle: at most 5 open challenges per user per 10 minutes.
  const recent = await db.query<{ n: string }>(
    "SELECT count(*) AS n FROM auth_challenges WHERE user_id=$1 AND created_at > $2",
    [user.id, new Date(clock.now().getTime() - 10 * 60_000).toISOString()],
  );
  if (Number(recent.rows[0]!.n) >= 5) throw new AuthError("rate_limited", "Too many connection attempts. Try again in a few minutes.");

  const id = randomBytes(12).toString("base64url");
  const nonce = randomBytes(32);
  const expiresAt = new Date(clock.now().getTime() + cfg.AUTH_CHALLENGE_TTL_MINUTES * 60_000);
  const message = [
    "BAGFLIP wallet verification",
    `Telegram user: ${user.telegram_id}`,
    `Challenge: ${id}`,
    `Expires: ${expiresAt.toISOString()}`,
    "Signing proves you own this NEAR account. It does not move funds.",
  ].join("\n");
  await db.query(
    `INSERT INTO auth_challenges(id, user_id, nonce_b64, message, recipient, expires_at, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, user.id, nonce.toString("base64"), message, cfg.NEP413_RECIPIENT, expiresAt.toISOString(), clock.now().toISOString()],
  );
  return { id, nonceB64: nonce.toString("base64"), message, recipient: cfg.NEP413_RECIPIENT, expiresAt };
}

export async function getChallenge(db: Tx, id: string) {
  const r = await db.query<{ id: string; user_id: string; nonce_b64: string; message: string; recipient: string; expires_at: string; used_at: string | null; failed_attempts: number }>(
    "SELECT * FROM auth_challenges WHERE id=$1",
    [id],
  );
  return r.rows[0] ?? null;
}

export class AuthError extends Error {
  public code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const NEAR_ACCOUNT = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

export interface LinkRequest {
  challengeId: string;
  accountId: string;
  publicKey: string;
  signature: string;
  /** Telegram user id proven by validated Mini App initData, if the page ran inside Telegram. */
  telegramUserId?: number;
}

export async function verifyAndLink(db: Db, chain: NearChain, clock: Clock, req: LinkRequest): Promise<{ walletId: string; accountId: string; userId: string; alreadyLinked: boolean }> {
  const accountId = req.accountId.trim().toLowerCase();
  if (!NEAR_ACCOUNT.test(accountId)) throw new AuthError("bad_account", "Invalid NEAR account ID");

  const ch = await getChallenge(db, req.challengeId);
  if (!ch) throw new AuthError("unknown_challenge", "Unknown challenge. Run /connect again.");
  if (ch.used_at) throw new AuthError("challenge_used", "This challenge was already used. Run /connect again.");
  if (new Date(ch.expires_at) < clock.now()) throw new AuthError("challenge_expired", "This challenge expired. Run /connect again.");
  if (ch.failed_attempts >= 5) throw new AuthError("challenge_locked", "Too many failed attempts. Run /connect again.");

  if (req.telegramUserId !== undefined) {
    const owner = await db.query<{ telegram_id: string }>("SELECT telegram_id FROM users WHERE id=$1", [ch.user_id]);
    if (owner.rows[0]?.telegram_id !== String(req.telegramUserId)) {
      throw new AuthError("telegram_mismatch", "This link was created for a different Telegram account.");
    }
  }

  const sigOk = verifyNep413Signature({
    message: ch.message,
    nonce: Buffer.from(ch.nonce_b64, "base64"),
    recipient: ch.recipient,
    publicKey: req.publicKey,
    signature: req.signature,
  });
  if (!sigOk) {
    await db.query("UPDATE auth_challenges SET failed_attempts = failed_attempts + 1 WHERE id=$1", [ch.id]);
    throw new AuthError("bad_signature", "Signature verification failed.");
  }
  if (!(await chain.isFullAccessKey(accountId, req.publicKey))) {
    await db.query("UPDATE auth_challenges SET failed_attempts = failed_attempts + 1 WHERE id=$1", [ch.id]);
    throw new AuthError("not_full_access", "That key is not a full-access key of this NEAR account.");
  }

  return db.tx(async (tx) => {
    // Single-use: only one request can flip used_at.
    const used = await tx.query("UPDATE auth_challenges SET used_at=$2 WHERE id=$1 AND used_at IS NULL AND expires_at > $2 RETURNING id", [ch.id, clock.now().toISOString()]);
    if (!used.rows.length) throw new AuthError("challenge_used", "This challenge was already used. Run /connect again.");

    const existing = await tx.query<{ id: string; user_id: string }>("SELECT id, user_id FROM wallets WHERE account_id=$1 AND unlinked_at IS NULL FOR UPDATE", [accountId]);
    const ex = existing.rows[0];
    if (ex && ex.user_id === ch.user_id) return { walletId: ex.id, accountId, userId: ch.user_id, alreadyLinked: true };
    if (ex) {
      // Proven ownership moves the wallet to the new Telegram user; their old vote is revoked.
      await unlinkWalletTx(tx, clock, ex.id, ex.user_id, "unlink");
    }
    const w = await tx.query<{ id: string }>(
      `INSERT INTO wallets(user_id, account_id, public_key, challenge_id, verified_at) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [ch.user_id, accountId, req.publicKey, ch.id, clock.now().toISOString()],
    );
    // Inherit the user's current preference so a new wallet votes with the others.
    const pref = await tx.query<{ choice: Choice }>(
      `SELECT v.choice FROM votes v JOIN wallets w ON w.id=v.wallet_id WHERE w.user_id=$1 AND w.unlinked_at IS NULL ORDER BY v.updated_at DESC LIMIT 1`,
      [ch.user_id],
    );
    if (pref.rows[0]) await setVoteTx(tx, clock, w.rows[0]!.id, ch.user_id, pref.rows[0].choice);
    return { walletId: w.rows[0]!.id, accountId, userId: ch.user_id, alreadyLinked: false };
  });
}

async function unlinkWalletTx(tx: Tx, clock: Clock, walletId: string, userId: string, action: "unlink" | "revoke") {
  await tx.query("UPDATE wallets SET unlinked_at=$2 WHERE id=$1 AND unlinked_at IS NULL", [walletId, clock.now().toISOString()]);
  const del = await tx.query("DELETE FROM votes WHERE wallet_id=$1 RETURNING wallet_id", [walletId]);
  if (del.rows.length || action === "unlink") {
    await tx.query("INSERT INTO vote_events(wallet_id, user_id, choice, action, created_at) VALUES ($1,$2,NULL,$3,$4)", [walletId, userId, action, clock.now().toISOString()]);
  }
}

export async function unlinkWallet(db: Db, clock: Clock, userId: string, accountId: string): Promise<boolean> {
  return db.tx(async (tx) => {
    const w = await tx.query<{ id: string }>("SELECT id FROM wallets WHERE user_id=$1 AND account_id=$2 AND unlinked_at IS NULL FOR UPDATE", [userId, accountId]);
    if (!w.rows[0]) return false;
    await unlinkWalletTx(tx, clock, w.rows[0].id, userId, "unlink");
    return true;
  });
}

async function setVoteTx(tx: Tx, clock: Clock, walletId: string, userId: string, choice: Choice) {
  const now = clock.now().toISOString();
  const prev = await tx.query<{ choice: Choice }>("SELECT choice FROM votes WHERE wallet_id=$1 FOR UPDATE", [walletId]);
  if (prev.rows[0]?.choice === choice) return false;
  await tx.query(
    `INSERT INTO votes(wallet_id, choice, updated_at) VALUES ($1,$2,$3)
     ON CONFLICT (wallet_id) DO UPDATE SET choice = EXCLUDED.choice, updated_at = EXCLUDED.updated_at`,
    [walletId, choice, now],
  );
  await tx.query("INSERT INTO vote_events(wallet_id, user_id, choice, action, created_at) VALUES ($1,$2,$3,'vote',$4)", [walletId, userId, choice, now]);
  return true;
}

/** Set the user's choice on every one of their verified wallets. Persists until changed. */
export async function castVote(db: Db, clock: Clock, userId: string, choice: Choice): Promise<{ wallets: number; changed: number }> {
  if (choice !== "DISTRIBUTE" && choice !== "AUTO_HUNT") throw new AuthError("bad_choice", "Invalid choice");
  return db.tx(async (tx) => {
    const ws = await tx.query<{ id: string }>("SELECT id FROM wallets WHERE user_id=$1 AND unlinked_at IS NULL", [userId]);
    if (!ws.rows.length) throw new AuthError("no_wallet", "Connect a NEAR wallet first with /connect.");
    let changed = 0;
    for (const w of ws.rows) if (await setVoteTx(tx, clock, w.id, userId, choice)) changed++;
    return { wallets: ws.rows.length, changed };
  });
}

export async function revokeVote(db: Db, clock: Clock, userId: string): Promise<number> {
  return db.tx(async (tx) => {
    const del = await tx.query<{ wallet_id: string }>(
      "DELETE FROM votes WHERE wallet_id IN (SELECT id FROM wallets WHERE user_id=$1 AND unlinked_at IS NULL) RETURNING wallet_id",
      [userId],
    );
    for (const r of del.rows) {
      await tx.query("INSERT INTO vote_events(wallet_id, user_id, choice, action, created_at) VALUES ($1,$2,NULL,'revoke',$3)", [r.wallet_id, userId, clock.now().toISOString()]);
    }
    return del.rows.length;
  });
}

export async function userWallets(db: Tx, userId: string) {
  const r = await db.query<{ id: string; account_id: string; verified_at: string; choice: Choice | null }>(
    `SELECT w.id, w.account_id, w.verified_at, v.choice FROM wallets w LEFT JOIN votes v ON v.wallet_id = w.id
     WHERE w.user_id=$1 AND w.unlinked_at IS NULL ORDER BY w.verified_at`,
    [userId],
  );
  return r.rows;
}

/** All active votes (one row per verified, linked wallet). */
export async function activeVotes(db: Tx) {
  const r = await db.query<{ wallet_id: string; user_id: string; account_id: string; choice: Choice }>(
    `SELECT w.id AS wallet_id, w.user_id, w.account_id, v.choice FROM votes v JOIN wallets w ON w.id = v.wallet_id
     JOIN users u ON u.id = w.user_id WHERE w.unlinked_at IS NULL AND NOT u.is_banned ORDER BY w.account_id`,
  );
  return r.rows;
}
