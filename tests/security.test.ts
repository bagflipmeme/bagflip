import { afterEach, describe, expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import { makeEnv, BAG, type TestEnv } from "./helpers.ts";
import { createChallenge, upsertUser, verifyAndLink, AuthError } from "../src/governance/wallets.ts";
import { publicKeyString, signNep413, verifyNep413Signature, nep413Hash } from "../src/near/nep413.ts";
import { validateInitData, signInitData } from "../src/api/telegram-auth.ts";
import { loadConfig } from "../src/shared/config.ts";
import { createLogger, registerSecret } from "../src/shared/log.ts";

let env: TestEnv;
afterEach(async () => {
  await env?.db.close();
  env = undefined as never;
});

async function setup() {
  env = await makeEnv();
  const sk = ed25519.utils.randomSecretKey();
  const pk = publicKeyString(sk);
  await env.chain.addKey("alice.near", pk);
  await env.chain.setBalance("alice.near", BAG(10));
  const user = await upsertUser(env.db, { id: 42 });
  const ch = await createChallenge(env.db, env.clock, env.cfg, user);
  const sign = (o: Partial<{ message: string; nonce: Uint8Array; recipient: string }> = {}, key = sk) =>
    signNep413(key, { message: o.message ?? ch.message, nonce: o.nonce ?? Buffer.from(ch.nonceB64, "base64"), recipient: o.recipient ?? ch.recipient });
  return { sk, pk, user, ch, sign };
}

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (e) {
    return e instanceof AuthError ? e.code : String(e);
  }
};

describe("NEP-413 wallet verification", () => {
  it("accepts a valid signature from a full-access key and binds it to the Telegram user", async () => {
    const s = await setup();
    const r = await verifyAndLink(env.db, env.chain, env.clock, { challengeId: s.ch.id, accountId: "alice.near", publicKey: s.pk, signature: s.sign(), telegramUserId: 42 });
    expect(r.accountId).toBe("alice.near");
    expect(s.ch.message).toContain("Telegram user: 42");
  });

  it("rejects replay of a used challenge", async () => {
    const s = await setup();
    const req = { challengeId: s.ch.id, accountId: "alice.near", publicKey: s.pk, signature: s.sign() };
    await verifyAndLink(env.db, env.chain, env.clock, req);
    expect(await code(verifyAndLink(env.db, env.chain, env.clock, req))).toBe("challenge_used");
  });

  it("rejects expired challenges", async () => {
    const s = await setup();
    env.clock.advance(11 * 60_000);
    expect(await code(verifyAndLink(env.db, env.chain, env.clock, { challengeId: s.ch.id, accountId: "alice.near", publicKey: s.pk, signature: s.sign() }))).toBe("challenge_expired");
  });

  it("rejects signatures over a different message, nonce or recipient (wrong app)", async () => {
    const s = await setup();
    const base = { challengeId: s.ch.id, accountId: "alice.near", publicKey: s.pk };
    expect(await code(verifyAndLink(env.db, env.chain, env.clock, { ...base, signature: s.sign({ message: "something else" }) }))).toBe("bad_signature");
    expect(await code(verifyAndLink(env.db, env.chain, env.clock, { ...base, signature: s.sign({ nonce: new Uint8Array(32) }) }))).toBe("bad_signature");
    expect(await code(verifyAndLink(env.db, env.chain, env.clock, { ...base, signature: s.sign({ recipient: "evil-app" }) }))).toBe("bad_signature");
  });

  it("rejects a valid signature whose key is not a full-access key of the claimed account", async () => {
    const s = await setup();
    const other = ed25519.utils.randomSecretKey();
    const sig = s.sign({}, other);
    expect(await code(verifyAndLink(env.db, env.chain, env.clock, { challengeId: s.ch.id, accountId: "alice.near", publicKey: publicKeyString(other), signature: sig }))).toBe("not_full_access");
    // and cannot claim someone else's account with own key
    expect(await code(verifyAndLink(env.db, env.chain, env.clock, { challengeId: s.ch.id, accountId: "bob.near", publicKey: s.pk, signature: s.sign() }))).toBe("not_full_access");
  });

  it("rejects a challenge used from a different Telegram account", async () => {
    const s = await setup();
    expect(await code(verifyAndLink(env.db, env.chain, env.clock, { challengeId: s.ch.id, accountId: "alice.near", publicKey: s.pk, signature: s.sign(), telegramUserId: 999 }))).toBe("telegram_mismatch");
  });

  it("locks a challenge after repeated bad signatures and rate-limits challenge creation", async () => {
    const s = await setup();
    for (let i = 0; i < 5; i++) await code(verifyAndLink(env.db, env.chain, env.clock, { challengeId: s.ch.id, accountId: "alice.near", publicKey: s.pk, signature: s.sign({ message: "x" }) }));
    expect(await code(verifyAndLink(env.db, env.chain, env.clock, { challengeId: s.ch.id, accountId: "alice.near", publicKey: s.pk, signature: s.sign() }))).toBe("challenge_locked");
    for (let i = 0; i < 4; i++) await createChallenge(env.db, env.clock, env.cfg, s.user);
    expect(await code(createChallenge(env.db, env.clock, env.cfg, s.user))).toBe("rate_limited");
  });

  it("matches the NEP-413 reference layout (tag 2^31+413, borsh payload, sha256)", () => {
    const h = nep413Hash({ message: "hi", nonce: new Uint8Array(32), recipient: "app" });
    expect(h.length).toBe(32);
    const sk = ed25519.utils.randomSecretKey();
    const sig = signNep413(sk, { message: "hi", nonce: new Uint8Array(32), recipient: "app" });
    expect(verifyNep413Signature({ message: "hi", nonce: new Uint8Array(32), recipient: "app", publicKey: publicKeyString(sk), signature: sig })).toBe(true);
    expect(verifyNep413Signature({ message: "hi", nonce: new Uint8Array(32), recipient: "app", publicKey: publicKeyString(sk), signature: "garbage" })).toBe(false);
  });
});

describe("Telegram Mini App initData", () => {
  const token = "123456:TEST-token";
  it("validates the HMAC and freshness", () => {
    const now = Date.now();
    const data = signInitData({ auth_date: String(Math.floor(now / 1000)), user: JSON.stringify({ id: 42 }), query_id: "q" }, token);
    expect(validateInitData(data, token, 86400, now)).toEqual({ ok: true, userId: 42 });
    expect(validateInitData(data, "999:other", 86400, now).ok).toBe(false);
    expect(validateInitData(data.replace("42", "43"), token, 86400, now).ok).toBe(false);
    expect(validateInitData(data, token, 60, now + 3_600_000).ok).toBe(false);
  });
});

describe("configuration safety", () => {
  const base = { MEME_TOKEN_CONTRACT_ID: "t.near", TREASURY_NEAR_ADDRESS: "tr.near", TRADING_WALLET_ADDRESS: "So1" };
  it("defaults to development with live trading disabled", () => {
    const c = loadConfig({});
    expect(c.BAGFLIP_ENV).toBe("development");
    expect(c.liveTrading).toBe(false);
    expect(c.liveTransfers).toBe(false);
    expect(c.TIMEZONE).toBe("Asia/Kuala_Lumpur");
  });
  it("refuses private keys or live flags outside live mode", () => {
    expect(() => loadConfig({ ...base, BAGFLIP_ENV: "paper", SOLANA_TRADING_PRIVATE_KEY: "abc" })).toThrow(/only be configured when BAGFLIP_ENV=live/);
    expect(() => loadConfig({ ...base, BAGFLIP_ENV: "paper", LIVE_TRADING_ENABLED: "true" })).toThrow(/require BAGFLIP_ENV=live/);
  });
  it("live mode needs Postgres, and live trading needs explicit enablement plus a key", () => {
    expect(() => loadConfig({ ...base, BAGFLIP_ENV: "live" })).toThrow(/DATABASE_URL/);
    const c = loadConfig({ ...base, BAGFLIP_ENV: "live", DATABASE_URL: "postgres://x" });
    expect(c.liveTrading).toBe(false);
    expect(() => loadConfig({ ...base, BAGFLIP_ENV: "live", DATABASE_URL: "postgres://x", LIVE_TRADING_ENABLED: "true" })).toThrow(/SOLANA_TRADING_PRIVATE_KEY/);
  });
  it("live transfers go through a separate operator account, never a vault key", () => {
    const live = { ...base, BAGFLIP_ENV: "live", DATABASE_URL: "postgres://x" };
    expect(() => loadConfig({ ...live, LIVE_TRANSFERS_ENABLED: "true" })).toThrow(/OPERATOR_ACCOUNT_ID and OPERATOR_PRIVATE_KEY/);
    expect(() => loadConfig({ ...live, LIVE_TRANSFERS_ENABLED: "true", OPERATOR_ACCOUNT_ID: "tr.near", OPERATOR_PRIVATE_KEY: "ed25519:x" })).toThrow(/separate bot account/);
    const ok = loadConfig({ ...live, LIVE_TRANSFERS_ENABLED: "true", OPERATOR_ACCOUNT_ID: "bot.near", OPERATOR_PRIVATE_KEY: "ed25519:x" });
    expect(ok.liveTransfers).toBe(true);
    expect(() => loadConfig({ ...base, BAGFLIP_ENV: "paper", OPERATOR_PRIVATE_KEY: "ed25519:x" })).toThrow(/only be configured when BAGFLIP_ENV=live/);
  });
  it("rejects the creator wallet as treasury", () => {
    expect(() => loadConfig({ ...base, BAGFLIP_ENV: "live", DATABASE_URL: "postgres://x", CREATOR_WALLET_ADDRESS: "tr.near" })).toThrow(/must not be the creator/);
  });
});

describe("log redaction", () => {
  it("never prints secrets", () => {
    const lines: string[] = [];
    registerSecret("super-secret-bot-token-123");
    const log = createLogger("debug", {}, (l) => lines.push(l));
    log.info("calling with super-secret-bot-token-123", { privateKey: "ed25519:abc", nested: { apiKey: "k", ok: 1 }, err: new Error("token super-secret-bot-token-123 bad") });
    const out = lines.join("\n");
    expect(out).not.toContain("super-secret-bot-token-123");
    expect(out).not.toContain("ed25519:abc");
    expect(out).toContain('"ok":1');
  });
});
