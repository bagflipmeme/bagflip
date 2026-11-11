import { ed25519 } from "@noble/curves/ed25519.js";
import { openDb, type Db } from "../src/db/index.ts";
import { testConfig, type Config } from "../src/shared/config.ts";
import { FakeClock } from "../src/shared/time.ts";
import { SimNearChain } from "../src/near/chain.ts";
import { publicKeyString, signNep413 } from "../src/near/nep413.ts";
import { createChallenge, upsertUser, verifyAndLink, castVote } from "../src/governance/wallets.ts";
import type { Choice } from "../src/governance/engine.ts";
import { parseUnits } from "../src/shared/money.ts";

export const BAG = (n: number | string) => parseUnits(String(n), 18);

export interface TestEnv {
  db: Db;
  clock: FakeClock;
  chain: SimNearChain;
  cfg: Config;
}

export async function makeEnv(over: Record<string, string> = {}, start = "2026-11-09T10:00:00Z"): Promise<TestEnv> {
  const db = await openDb({ memory: true });
  const clock = new FakeClock(new Date(start));
  const chain = new SimNearChain(db, clock);
  const cfg = testConfig(over);
  return { db, clock, chain, cfg };
}

let tgSeq = 1000;

/** Create a Telegram user who proves ownership of `accountId` via a real NEP-413 signature. */
export async function linkedUser(env: TestEnv, accountId: string, balance: bigint, opts: { telegramId?: number } = {}) {
  const sk = ed25519.utils.randomSecretKey();
  const pk = publicKeyString(sk);
  await env.chain.addKey(accountId, pk);
  await env.chain.setBalance(accountId, balance);
  const user = await upsertUser(env.db, { id: opts.telegramId ?? tgSeq++, username: accountId.split(".")[0] });
  const ch = await createChallenge(env.db, env.clock, env.cfg, user);
  const signature = signNep413(sk, { message: ch.message, nonce: Buffer.from(ch.nonceB64, "base64"), recipient: ch.recipient });
  const link = await verifyAndLink(env.db, env.chain, env.clock, { challengeId: ch.id, accountId, publicKey: pk, signature });
  return { user, sk, pk, walletId: link.walletId };
}

/** Link an extra wallet to an existing user. */
export async function linkExtraWallet(env: TestEnv, user: { id: string; telegram_id: string }, accountId: string, balance: bigint) {
  const sk = ed25519.utils.randomSecretKey();
  const pk = publicKeyString(sk);
  await env.chain.addKey(accountId, pk);
  await env.chain.setBalance(accountId, balance);
  const ch = await createChallenge(env.db, env.clock, env.cfg, user as never);
  const signature = signNep413(sk, { message: ch.message, nonce: Buffer.from(ch.nonceB64, "base64"), recipient: ch.recipient });
  return verifyAndLink(env.db, env.chain, env.clock, { challengeId: ch.id, accountId, publicKey: pk, signature });
}

export async function vote(env: TestEnv, userId: string, choice: Choice) {
  return castVote(env.db, env.clock, userId, choice);
}
