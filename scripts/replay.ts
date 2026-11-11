/**
 * Replay the strategy over recorded observations.
 *   node scripts/replay.ts                 # uses DATABASE_URL / PGLITE_DATA_DIR
 *   node scripts/replay.ts --file obs.json # array of TokenMarket objects
 *   node scripts/replay.ts --since 2026-11-01
 */
import { readFileSync } from "node:fs";
import { loadConfig } from "../src/shared/config.ts";
import { openDb } from "../src/db/index.ts";
import { replay } from "../src/strategy/replay.ts";
import { strategyParams, exitParams } from "../src/trading/hunt.ts";
import { formatAsset } from "../src/shared/money.ts";
import type { TokenMarket } from "../src/market/types.ts";

const args = process.argv.slice(2);
const arg = (k: string) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : undefined;
};
const cfg = loadConfig({ ...process.env, BAGFLIP_ENV: process.env.BAGFLIP_ENV === "live" ? "paper" : process.env.BAGFLIP_ENV, SOLANA_TRADING_PRIVATE_KEY: "", TREASURY_NEAR_PRIVATE_KEY: "", LIVE_TRADING_ENABLED: "", LIVE_TRANSFERS_ENABLED: "" });

let obs: TokenMarket[];
const file = arg("--file");
if (file) obs = JSON.parse(readFileSync(file, "utf8")) as TokenMarket[];
else {
  const db = await openDb(cfg.DATABASE_URL ? { url: cfg.DATABASE_URL } : { dataDir: cfg.PGLITE_DATA_DIR });
  const since = arg("--since");
  const r = await db.query<{ data: TokenMarket; observed_at: string }>(
    `SELECT data, observed_at FROM market_observations ${since ? "WHERE observed_at >= $1" : ""} ORDER BY observed_at`,
    since ? [since] : [],
  );
  obs = r.rows.map((x) => ({ ...x.data, observedAt: new Date(x.observed_at).getTime() }));
  await db.close();
}
const start = BigInt(Math.round(Number(arg("--start-sol") ?? "1") * 1e9));
const res = replay(obs, {
  strategy: strategyParams(cfg),
  exits: exitParams(cfg),
  startLamports: start,
  positionPct: cfg.POSITION_SIZE_PERCENT,
  maxConcurrent: cfg.MAX_CONCURRENT_POSITIONS,
  feeBps: 125,
  extraSlippageBps: cfg.PAPER_EXTRA_SLIPPAGE_BPS,
  networkFeeLamports: 5_000n + BigInt(cfg.PRIORITY_FEE_LAMPORTS),
  solUsd: 85,
});
console.log(`observations: ${obs.length}, distinct tokens: ${new Set(obs.map((o) => o.mint)).size}`);
for (const t of res.trades) {
  console.log(`${t.closedAt ? "closed" : "open  "} ${t.symbol.padEnd(10)} cost ${formatAsset(t.cost, "SOL")} pnl ${formatAsset(t.pnl, "SOL")} (${((Number(t.pnl) / Number(t.cost)) * 100).toFixed(1)}%) ${t.reason}`);
}
console.log(`start ${formatAsset(start, "SOL")} → equity ${formatAsset(res.endEquity, "SOL")} (${res.returnPct.toFixed(1)}%), wins ${res.wins}, losses ${res.losses}`);
console.log("Replay is an optimistic upper bound: it cannot model failed exits or rugs between observations.");
