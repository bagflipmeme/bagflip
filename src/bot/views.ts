/** Telegram message rendering (parse_mode HTML). Pure functions of DB state. */
import type { Db } from "../db/index.ts";
import type { Config } from "../shared/config.ts";
import { formatLocal, nextBoundary } from "../shared/time.ts";
import { formatAsset, formatUnits, formatUsd, toUsdMicro } from "../shared/money.ts";
import { esc } from "../shared/outbox.ts";
import { currentDecision, getLiveTally } from "../governance/cycle.ts";
import { percentOf, type Mode } from "../governance/engine.ts";
import { treasurySummary } from "../treasury/treasury.ts";
import type { PriceOracle } from "../treasury/prices.ts";
import { pnlStats } from "../trading/pnl.ts";
import { getState } from "../db/index.ts";
import { nearblocksAccount, solscanAccount, solscanTx } from "../solana/rpc.ts";

export const MODE_LABEL: Record<Mode, string> = { INACTIVE: "⚪ INACTIVE (no trading)", DISTRIBUTE: "💰 DISTRIBUTE", AUTO_HUNT: "🔥 AUTO HUNT" };

const bar = (pct: number) => {
  const n = Math.round(pct / 10);
  return "█".repeat(n) + "░".repeat(10 - n);
};

export function envTag(cfg: Config) {
  return cfg.BAGFLIP_ENV === "live" ? "" : `\n<i>Environment: ${cfg.BAGFLIP_ENV} — ${cfg.BAGFLIP_ENV === "paper" ? "virtual capital, no real trades" : "simulated chain, no real funds"}</i>`;
}

export async function governanceMessage(db: Db, cfg: Config, prices: PriceOracle, now: Date): Promise<string> {
  const dec = await currentDecision(db);
  const mode: Mode = dec?.effective_mode ?? "INACTIVE";
  const tally = await getLiveTally(db);
  const t = await treasurySummary(db, prices);
  const next = nextBoundary(cfg.boundary, now);
  const lines = [
    "<b>BAGFLIP GOVERNANCE</b>",
    "",
    `Treasury: <b>${t.totalUsdMicro !== null ? formatUsd(t.totalUsdMicro) : formatAsset(t.near.total, "NEAR")}</b>`,
    `Current Mode: <b>${MODE_LABEL[mode]}</b>`,
    "",
  ];
  if (tally && tally.wallets > 0) {
    lines.push(`🔥 AUTO HUNT: <b>${tally.huntPct.toFixed(1)}%</b> ${bar(tally.huntPct)}`);
    lines.push(`💰 DISTRIBUTE: <b>${tally.distributePct.toFixed(1)}%</b> ${bar(tally.distributePct)}`);
    lines.push(`<i>${tally.wallets} verified wallet(s), weighted by ${esc(cfg.MEME_TOKEN_SYMBOL)} held · live tally, binding snapshot at midnight</i>`);
  } else lines.push("<i>No weighted votes yet. Connect a wallet in DM and vote.</i>");
  lines.push("", `Next Decision: <b>${String(cfg.DAILY_DECISION_HOUR).padStart(2, "0")}:${String(cfg.DAILY_DECISION_MINUTE).padStart(2, "0")} MYT</b> (${formatLocal(cfg.TIMEZONE, next)})`);
  lines.push("Your vote stays active every day until you change it.");
  return lines.join("\n") + envTag(cfg);
}

export function voteKeyboard() {
  return { inline_keyboard: [[{ text: "💰 DISTRIBUTE", callback_data: "v:D" }, { text: "🔥 AUTO HUNT", callback_data: "v:H" }]] };
}

export function decisionAnnouncement(
  d: { cycle_id: string; effective_mode: Mode; previous_mode: Mode; changed: boolean; reason: string; weight_distribute: string; weight_hunt: string; distinct_wallets: number; block_height: string; quorum_met: boolean },
  cfg: Config,
): string {
  const D = BigInt(d.weight_distribute);
  const H = BigInt(d.weight_hunt);
  const head = d.changed ? `🔔 <b>MODE CHANGE → ${MODE_LABEL[d.effective_mode]}</b>` : `🗳️ <b>Daily decision: ${MODE_LABEL[d.effective_mode]} continues</b>`;
  return [
    head,
    `Cycle ${d.cycle_id} · snapshot NEAR block ${d.block_height}`,
    `🔥 AUTO HUNT ${percentOf(H, D + H).toFixed(1)}% · 💰 DISTRIBUTE ${percentOf(D, D + H).toFixed(1)}% · ${d.distinct_wallets} wallet(s)`,
    `<i>${esc(d.reason)}</i>`,
    d.changed && d.effective_mode === "DISTRIBUTE" ? "No new trades. Open positions are being unwound; recovered funds go to holders." : "",
    d.changed && d.effective_mode === "AUTO_HUNT" ? "Unreserved treasury capital is now available to the autonomous trading engine. It can lose everything." : "",
  ]
    .filter(Boolean)
    .join("\n") + envTag(cfg);
}

export async function statusMessage(db: Db, cfg: Config, prices: PriceOracle, now: Date): Promise<string> {
  const g = await governanceMessage(db, cfg, prices, now);
  const ts = await getState<{ state: string; reasons: string[]; exec: string }>(db, "trading_status");
  const lines = [g, "", `<b>Trading engine</b>: ${ts ? (ts.state === "active" ? `🟢 hunting (${ts.exec})` : `⏸️ idle — ${esc(ts.reasons[0] ?? "")}`) : "not started"}`];
  const dec = await currentDecision(db);
  if (dec) lines.push(`Last decision: ${dec.cycle_id} — <i>${esc(dec.reason)}</i>`);
  return lines.join("\n");
}

export async function treasuryMessage(db: Db, cfg: Config, prices: PriceOracle): Promise<string> {
  const t = await treasurySummary(db, prices);
  const usd = (v: bigint, a: "NEAR" | "SOL") => {
    const p = a === "NEAR" ? t.priceNear : t.priceSol;
    return p ? ` (${formatUsd(toUsdMicro(v, a, p))})` : "";
  };
  const pnlSign = t.sol.realizedPnl >= 0n ? "+" : "";
  return [
    "<b>BAGFLIP TREASURY</b>",
    t.totalUsdMicro !== null ? `Marked total: <b>${formatUsd(t.totalUsdMicro)}</b> <i>(positions at last executable quote)</i>` : "",
    "",
    "<b>NEAR treasury</b>",
    `Available (unreserved): ${formatAsset(t.near.available, "NEAR")}${usd(t.near.available, "NEAR")}`,
    `Reserved for distribution: ${formatAsset(t.near.distributionPool, "NEAR")}${usd(t.near.distributionPool, "NEAR")}`,
    `Claimable by holders: ${formatAsset(t.near.claimable, "NEAR")}${usd(t.near.claimable, "NEAR")}`,
    `In transit to Solana: ${formatAsset(t.near.bridgeOutbound, "NEAR")}`,
    "",
    "<b>Solana trading</b>",
    `Trading capital: ${formatAsset(t.sol.tradingAvailable, "SOL")}${usd(t.sol.tradingAvailable, "SOL")}`,
    `Open positions (cost): ${formatAsset(t.sol.positionsCost, "SOL")} · marked ${formatAsset(t.unrealizedValueLamports, "SOL")}`,
    `In transit to NEAR: ${formatAsset(t.sol.bridgeInbound, "SOL")}`,
    `Realized P&L: ${pnlSign}${formatAsset(t.sol.realizedPnl, "SOL")}`,
    "",
    `Lifetime deposits: ${formatAsset(t.near.totalDeposited, "NEAR")} · distributed: ${formatAsset(t.near.totalDistributed, "NEAR")}`,
    `Network/bridge fees: ${formatAsset(t.near.fees, "NEAR")} + ${formatAsset(t.sol.fees, "SOL")}`,
    "",
    cfg.TREASURY_NEAR_ADDRESS ? `Treasury: <a href="${nearblocksAccount(cfg.TREASURY_NEAR_ADDRESS)}">${esc(cfg.TREASURY_NEAR_ADDRESS)}</a>` : "",
    cfg.TRADING_WALLET_ADDRESS ? `Trading wallet: <a href="${solscanAccount(cfg.TRADING_WALLET_ADDRESS)}">${esc(cfg.TRADING_WALLET_ADDRESS.slice(0, 6))}…${esc(cfg.TRADING_WALLET_ADDRESS.slice(-4))}</a>` : "",
    cfg.CREATOR_WALLET_ADDRESS ? `Creator (reward source, not traded): ${esc(cfg.CREATOR_WALLET_ADDRESS)}` : "",
  ]
    .filter((l) => l !== "")
    .join("\n") + envTag(cfg);
}

export async function tradesMessage(db: Db, cfg: Config): Promise<string> {
  const open = await db.query<{ id: string; symbol: string | null; mint: string; cost_lamports: string; remaining_cost_lamports: string; last_value_lamports: string | null; opened_at: string; exec_mode: string }>(
    "SELECT * FROM trading_positions WHERE status IN ('open','closing','opening') ORDER BY opened_at DESC LIMIT 10",
  );
  const closed = await db.query<{ id: string; symbol: string | null; status: string; cost_lamports: string; realized_pnl_lamports: string; exit_reason: string | null; closed_at: string; exec_mode: string }>(
    "SELECT * FROM trading_positions WHERE status IN ('closed','written_off') ORDER BY closed_at DESC LIMIT 8",
  );
  const lines = ["<b>AUTO HUNT TRADES</b>", "", "<b>Open</b>"];
  if (!open.rows.length) lines.push("<i>none</i>");
  for (const p of open.rows) {
    const rc = BigInt(p.remaining_cost_lamports);
    const v = p.last_value_lamports ? BigInt(p.last_value_lamports) : null;
    const u = v !== null && rc > 0n ? ((Number(v) / Number(rc) - 1) * 100).toFixed(1) : "?";
    lines.push(`• $${esc(p.symbol ?? "?")} — cost ${formatAsset(BigInt(p.cost_lamports), "SOL")}, unrealized ${u}% <code>${p.mint.slice(0, 6)}…</code>`);
  }
  lines.push("", "<b>Recent</b>");
  if (!closed.rows.length) lines.push("<i>none yet</i>");
  for (const p of closed.rows) {
    const pnl = BigInt(p.realized_pnl_lamports);
    const cost = BigInt(p.cost_lamports);
    lines.push(`${pnl >= 0n ? "🟢" : "🔴"} $${esc(p.symbol ?? "?")} ${pnl >= 0n ? "+" : ""}${formatAsset(pnl, "SOL")} (${cost > 0n ? ((Number(pnl) / Number(cost)) * 100).toFixed(1) : "0"}%) · ${esc(p.exit_reason ?? p.status)}`);
  }
  const txs = await db.query<{ hash: string; kind: string; simulated: boolean }>("SELECT hash, kind, simulated FROM chain_transactions WHERE chain='solana' AND status='confirmed' ORDER BY id DESC LIMIT 5");
  if (txs.rows.some((t) => !t.simulated)) {
    lines.push("", "<b>Latest Solana txs</b>");
    for (const t of txs.rows.filter((x) => !x.simulated)) lines.push(`<a href="${solscanTx(t.hash)}">${t.kind} ${t.hash.slice(0, 8)}…</a>`);
  }
  return lines.join("\n") + envTag(cfg);
}

export async function pnlMessage(db: Db, cfg: Config, prices: PriceOracle): Promise<string> {
  const s = await pnlStats(db);
  const p = await prices.usd("SOL");
  const usd = (v: bigint) => (p ? ` (${formatUsd(toUsdMicro(v, "SOL", p))})` : "");
  return [
    "<b>AUTO HUNT PERFORMANCE</b>",
    `Closed positions: ${s.closed} · wins ${s.wins} · losses ${s.losses}${s.writtenOff ? ` (${s.writtenOff} written off)` : ""}`,
    `Win rate: ${s.winRatePct.toFixed(0)}%`,
    `Realized P&L (net of all fees): <b>${s.realizedLamports >= 0n ? "+" : ""}${formatAsset(s.realizedLamports, "SOL")}</b>${usd(s.realizedLamports)}`,
    `Capital deployed: ${formatAsset(s.costLamports, "SOL")} · fees paid: ${formatAsset(s.feesLamports, "SOL")}`,
    `Best: ${formatAsset(s.bestLamports, "SOL")} · worst: ${formatAsset(s.worstLamports, "SOL")} · avg hold ${s.avgHoldMinutes.toFixed(0)}m`,
    `Open: ${s.open} · unrealized ${formatAsset(s.unrealizedLamports, "SOL")} <i>(at executable quotes, not realized)</i>`,
    s.failedEntries ? `Entries that failed or expired (no position created): ${s.failedEntries}` : "",
    "",
    "<i>Extremely high risk. Past results say nothing about future results. Capital can go to zero.</i>",
  ]
    .filter(Boolean)
    .join("\n") + envTag(cfg);
}

export function powerLine(cfg: Config, accountId: string, balance: bigint | null, choice: string | null) {
  return `• <code>${esc(accountId)}</code>: ${balance === null ? "?" : formatUnits(balance, cfg.MEME_TOKEN_DECIMALS, 2)} ${esc(cfg.MEME_TOKEN_SYMBOL)} → ${choice ? MODE_LABEL[choice as Mode] : "no vote"}`;
}

export const HELP = (cfg: Config) =>
  [
    "<b>BAGFLIP</b> — a community-controlled meme treasury.",
    `Creator tax rewards flow into a public treasury. ${esc(cfg.MEME_TOKEN_SYMBOL)} holders decide, continuously, what happens to it:`,
    "💰 <b>DISTRIBUTE</b> — rewards are split pro-rata to holders and claimable.",
    "🔥 <b>AUTO HUNT</b> — an autonomous bot trades extremely risky Solana meme tokens with it. It can lose 100%.",
    "",
    "/start — intro",
    "/connect — verify a NEAR wallet (signed message, no funds move)",
    "/vote — choose DISTRIBUTE or AUTO HUNT (stays active until you change it)",
    "/status — current mode, weighted votes, next decision",
    "/treasury — balances, reservations, P&L, public wallets",
    "/power — your verified wallets and voting power",
    "/trades — open and recent AUTO HUNT trades",
    "/pnl — trading performance",
    "/claim — collect your distribution rewards",
    "/disconnect &lt;account&gt; — unlink a wallet (revokes its vote)",
    "/council — the top-holder council that can veto payout lists and pause the vault",
    "/disclosures — risks, custody and how voting works",
    "",
    `Voting power = ${esc(cfg.MEME_TOKEN_SYMBOL)} held by your verified wallets at the 00:00 MYT snapshot. The mode changes only when the other option has more than 50% of weighted votes and quorum is met.`,
  ].join("\n");

export const DISCLOSURES = (cfg: Config) =>
  [
    "<b>BAGFLIP disclosures</b>",
    "• <b>Weighted voting.</b> One token = one vote, read on-chain at one NEAR block at 00:00 MYT. Large holders have proportionally more influence.",
    `• <b>Custody.</b> The reward treasury ${esc(cfg.TREASURY_NEAR_ADDRESS || "(not configured)")} is a smart-contract vault with no keys: nobody, including the creator, can withdraw from it. Money leaves only as claims to accounts in a published payout list (after a Holder Council veto window) or as capped, time-locked transfers to the trading route. The bot still computes payout lists and holds the Solana trading key; the Holder Council (the top token holders, decided on chain) can veto or pause.`,
    "• <b>Total-loss risk.</b> AUTO HUNT trades extremely speculative meme tokens. Rug pulls, failed exits, congestion and fees can destroy the entire trading capital. Stops and targets are best-effort, not guarantees. There is no promise of profit.",
    "• <b>Distributions</b> are paid only from funds actually recovered and reconciled. Unclaimed rewards stay reserved.",
    "• <b>No advice.</b> Nothing here is investment, legal or tax advice. Participation may have legal or tax consequences where you live.",
    "• Your wallet is verified with a signed message. BAGFLIP never asks for seed phrases, private keys or passwords.",
  ].join("\n");
