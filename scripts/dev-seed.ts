/**
 * DEVELOPMENT ONLY: seed simulated holders who link wallets through the real
 * NEP-413 verification path, cast votes, and a simulated reward deposit.
 * Refuses to run outside BAGFLIP_ENV=development. Stop the app first (PGlite is single-process).
 *   node scripts/dev-seed.ts
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import { loadConfig } from "../src/shared/config.ts";
import { openDb } from "../src/db/index.ts";
import { systemClock } from "../src/shared/time.ts";
import { SimNearChain } from "../src/near/chain.ts";
import { publicKeyString, signNep413 } from "../src/near/nep413.ts";
import { upsertUser, createChallenge, verifyAndLink, castVote } from "../src/governance/wallets.ts";
import { recordDeposit } from "../src/treasury/treasury.ts";
import { FixedPrices } from "../src/treasury/prices.ts";
import { parseUnits } from "../src/shared/money.ts";

const cfg = loadConfig();
if (cfg.BAGFLIP_ENV !== "development") throw new Error("dev-seed only runs with BAGFLIP_ENV=development");
const db = await openDb(cfg.DATABASE_URL ? { url: cfg.DATABASE_URL } : { dataDir: cfg.PGLITE_DATA_DIR });
const chain = new SimNearChain(db, systemClock);
const holders: [string, string, "DISTRIBUTE" | "AUTO_HUNT" | null][] = [
  ["sim-whale.near", "1000000", "AUTO_HUNT"],
  ["sim-bagflip.near", "50000", "AUTO_HUNT"],
  ["sim-saver.near", "400000", "DISTRIBUTE"],
  ["sim-holder.near", "1000", null],
];
let tg = 900_000_001;
for (const [acct, bal, choice] of holders) {
  await chain.setBalance(acct, parseUnits(bal, cfg.MEME_TOKEN_DECIMALS));
  const sk = ed25519.utils.randomSecretKey();
  const pk = publicKeyString(sk);
  await chain.addKey(acct, pk);
  const u = await upsertUser(db, { id: tg++, username: acct.split(".")[0] });
  const ch = await createChallenge(db, systemClock, cfg, u);
  const signature = signNep413(sk, { message: ch.message, nonce: Buffer.from(ch.nonceB64, "base64"), recipient: ch.recipient });
  await verifyAndLink(db, chain, systemClock, { challengeId: ch.id, accountId: acct, publicKey: pk, signature });
  if (choice) await castVote(db, systemClock, u.id, choice);
  console.log(`seeded ${acct} (${bal} ${cfg.MEME_TOKEN_SYMBOL}) → ${choice ?? "no vote"}`);
}
const id = `sim-seed-${Date.now()}`;
await recordDeposit({ db, clock: systemClock, cfg, chain, prices: new FixedPrices({ NEAR: 3.5, SOL: 85 }) }, { txHash: id, receiptId: id, sender: cfg.CREATOR_WALLET_ADDRESS || "creator.sim", amount: parseUnits("12", 24), source: "sim" });
console.log("seeded a simulated 12 NEAR reward deposit");
await db.close();
