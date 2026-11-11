/**
 * Watch the live market with the real scanner + strategy for N minutes and
 * print what AUTO HUNT would consider. No DB, no treasury, no orders.
 *   node scripts/paper-scan.ts --minutes 3
 */
import { DexScreenerMarket } from "../src/market/dexscreener.ts";
import { OnChainSafety } from "../src/market/safety.ts";
import { SolanaChain } from "../src/solana/rpc.ts";
import { JupiterClient } from "../src/solana/execution/jupiter.ts";
import { scoreToken, confirmEntry, DEFAULT_PARAMS } from "../src/strategy/strategy.ts";
import { createLogger } from "../src/shared/log.ts";

const args = process.argv.slice(2);
const minutes = Number(args[args.indexOf("--minutes") + 1] || 3);
const env = process.env;
const log = createLogger("warn");
const ds = new DexScreenerMarket(env.DEXSCREENER_BASE_URL || "https://api.dexscreener.com", log, { pumpPortalWs: env.PUMPPORTAL_WS_URL || "wss://pumpportal.fun/api/data" });
ds.startDiscoveryStream();
const sol = new SolanaChain(env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com");
const safety = new OnChainSafety(sol);
const jup = new JupiterClient(env.JUPITER_BASE_URL || "https://api.jup.ag/swap/v2", env.JUPITER_API_KEY || undefined);
const signals = new Map<string, { score: number; priceNative: number; at: number }>();
const end = Date.now() + minutes * 60_000;
let scans = 0;
let seen = 0;
const best: { sym: string; score: number; rejects: string[] }[] = [];

while (Date.now() < end) {
  const now = Date.now();
  const c = await ds.candidates(now);
  if (c.length) {
    const snap = await ds.snapshot(c.map((x) => x.mint)).catch((e) => (console.log("snapshot error", String(e)), []));
    seen += snap.length;
    for (const m of snap) {
      const s = scoreToken(m, now, DEFAULT_PARAMS);
      best.push({ sym: m.symbol, score: s.score, rejects: s.rejects });
      const cur = { score: s.score, priceNative: m.priceNative ?? 0, at: now };
      if (!s.pass) continue;
      const conf = confirmEntry(signals.get(m.mint), cur, DEFAULT_PARAMS.entryScore);
      signals.set(m.mint, cur);
      console.log(`[signal] ${m.symbol} ${m.dexId} score ${s.score} ${conf.why}`);
      if (!conf.confirmed) continue;
      const sf = await safety.check(m).catch((e) => ({ ok: false, reasons: [String(e)], facts: {} }));
      const q = await jup.quote("buy", m.mint, 100_000_000n).catch(() => null);
      const back = q ? await jup.quote("sell", m.mint, q.outAmount).catch(() => null) : null;
      console.log(`[candidate] ${m.symbol} safety=${sf.ok ? "ok" : sf.reasons.join("; ")} roundtrip=${back ? ((1 - Number(back.outAmount) / 1e8) * 100).toFixed(2) + "%" : "no route"} → ${sf.ok && back ? "WOULD ENTER (paper)" : "skip"}`);
    }
  }
  scans++;
  await new Promise((r) => setTimeout(r, 30_000));
}
ds.stop();
best.sort((a, b) => b.score - a.score);
console.log(`\n${scans} scans, ${seen} pair snapshots. Top scores:`);
for (const b of best.slice(0, 8)) console.log(`  ${b.sym.padEnd(12)} ${b.score.toFixed(3)}  ${b.rejects.slice(0, 2).join("; ") || "passes filters"}`);
process.exit(0);
