/**
 * Notification outbox. Services write announcements inside their own DB
 * transaction (so a notification exists iff the event committed); the bot
 * drains the outbox to Telegram. Keys make every announcement idempotent.
 */
import type { Tx } from "../db/index.ts";
import type { Clock } from "./time.ts";

export type NotifyKind =
  | "deposit"
  | "decision"
  | "mode_change"
  | "position_open"
  | "position_close"
  | "session_pnl"
  | "claimable"
  | "failure"
  | "pause"
  | "admin";

export async function notify(tx: Tx, clock: Clock, key: string, kind: NotifyKind, text: string, chat: "group" | "admins" | `user:${string}` = "group") {
  await tx.query(
    `INSERT INTO notifications(key, kind, text, chat, created_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (key) DO NOTHING`,
    [key, kind, text, chat, clock.now().toISOString()],
  );
}

/** HTML-escape for Telegram parse_mode=HTML. */
export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
