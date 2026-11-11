/**
 * Live paper comparison of strategy variants on real market data. No treasury, no keys, no orders:
 * the real engine stays INACTIVE (no governance decision) and only the shadow books trade virtual SOL
 * with paper fills on real Jupiter quotes.
 *   node scripts/paper-compare.ts --minutes 60 --variants original,aggressive --start-sol 1
 * Writes a JSON report to data/paper-compare-<timestamp>.json.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { loadConfig } from "../src/shared/config.ts";
import { openDb } from "../src/db/index.ts";
import { buildApp } from "../src/app.ts";
import { createLogger } from "../src/shared/log.ts";
import { experimentReport, funnelReport, formatExperiment, formatFunnel } from "../src/trading/report.ts";

const args = process.argv.slice(2);
const arg = (k: string, d: string) => {
  const i = args.indexOf(k);
  return i >= 0 && args[i + 1] ? args[i + 1]! : d;
};
const minutes = Number(arg("--minutes", "30"));
const cfg = loadConfig({
  ...process.env,
  BAGFLIP_ENV: "paper",
  MEME_TOKEN_CONTRACT_ID: process.env.MEME_TOKEN_CONTRACT_ID || "bagflip.v2-launchpad.justhoot.near",
  TREASURY_NEAR_ADDRESS: process.env.TREASURY_NEAR_ADDRESS || "bagflip-vault.near",
  SHADOW_VARIANTS: arg("--variants", "original,aggressive"),
  SHADOW_START_SOL: arg("--start-sol", "1"),
  SCAN_INTERVAL_SECONDS: arg("--scan-seconds", "15"),
  POSITION_CHECK_INTERVAL_SECONDS: "15",
  TELEGRAM_BOT_TOKEN: "",
  SOLANA_TRADING_PRIVATE_KEY: "",
  OPERATOR_PRIVATE_KEY: "",
  LIVE_TRADING_ENABLED: "",
  LIVE_TRANSFERS_ENABLED: "",
  LOG_LEVEL: "warn",
});
const db = await openDb({ memory: true });
const app = await buildApp(cfg, { db, log: createLogger("warn") });
(app.market as { startDiscoveryStream?: () => void }).startDiscoveryStream?.();
console.log(`paper comparison: ${cfg.SHADOW_VARIANTS.join(" vs ")} for ${minutes} min, ${cfg.SHADOW_START_SOL} SOL virtual each`);

const end = Date.now() + minutes * 60_000;
let ticks = 0;
let lastPrint = Date.now();
while (Date.now() < end) {
  try {
    await app.hunt.tick();
  } catch (e) {
    console.log("tick error", String(e));
  }
  ticks++;
  if (Date.now() - lastPrint > 5 * 60_000) {
    lastPrint = Date.now();
    for (const s of app.hunt.shadows) {
      const x = s.summary();
      console.log(`[${new Date().toISOString().slice(11, 19)}] ${x.variant}: entries ${x.entries}, closed ${x.closed}, open ${x.open.length}, net ${x.returnPct}%, failures ${x.entryFailures}/${x.exitFailures}`);
    }
  }
  await new Promise((r) => setTimeout(r, 5_000));
}

const rows = await experimentReport(db, app.hunt.shadows);
const funnels = await Promise.all(app.hunt.shadows.map((s) => funnelReport(db, s.label, 24)));
const trades = (await db.query("SELECT variant, symbol, mint, opened_at, closed_at, cost_lamports, proceeds_lamports, pnl_lamports, exit_reason, entry_score, entry_why FROM shadow_trades ORDER BY id")).rows;
const strip = (s: string) => s.replace(/<[^>]+>/g, "");
console.log("\n" + strip(formatExperiment(rows)));
for (const f of funnels) console.log("\n" + strip(formatFunnel(f)));
mkdirSync("data", { recursive: true });
const file = `data/paper-compare-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
writeFileSync(file, JSON.stringify({ minutes, ticks, results: rows, funnels, trades }, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
console.log(`\nreport: ${file}`);
await app.close();
process.exit(0);
