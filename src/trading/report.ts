/** Scanner funnel and variant-comparison reports (API, Telegram admin commands, scripts). */
import type { Db } from "../db/index.ts";
import { formatAsset } from "../shared/money.ts";
import { mergeFunnels, type Funnel } from "./evaluate.ts";
import type { ShadowBook } from "./shadow.ts";

export async function funnelReport(db: Db, variant: string, sinceHours = 24) {
  const r = await db.query<{ data: Funnel }>("SELECT data FROM scan_funnel WHERE variant=$1 AND at >= $2 ORDER BY at", [variant, new Date(Date.now() - sinceHours * 3_600_000).toISOString()]);
  const list = r.rows.map((x) => x.data);
  const last = list.at(-1);
  return { ...mergeFunnels(list), variant, sinceHours, lastDiscovery: last?.discovery ?? null, recentSamples: list.slice(-5).flatMap((f) => f.samples).slice(-25) };
}

export async function experimentReport(db: Db, books: ShadowBook[], sinceHours = 24 * 7) {
  const out = [];
  for (const b of books) {
    const trades = await db.query<{ n: string; pnl: string | null; wins: string }>(
      "SELECT count(*)::text AS n, SUM(pnl_lamports)::text AS pnl, count(*) FILTER (WHERE pnl_lamports > 0)::text AS wins FROM shadow_trades WHERE variant=$1 AND closed_at >= $2",
      [b.vc.name, new Date(b.startedAt).toISOString()],
    );
    out.push({
      ...b.summary(),
      persistedClosedTrades: Number(trades.rows[0]!.n),
      funnel: await funnelReport(db, b.label, sinceHours),
    });
  }
  return out;
}

const top = (rec: Record<string, number>, n = 4) =>
  Object.entries(rec)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k, v]) => `${k} ×${v}`)
    .join(", ") || "—";

export function formatFunnel(r: Awaited<ReturnType<typeof funnelReport>>): string {
  const filtered = Object.values(r.filtered).reduce((s, v) => s + v, 0);
  return [
    `<b>Scanner funnel: ${r.variant}</b> (last ${r.sinceHours}h, ${r.scans} scans)`,
    `Discovered (new): ${top(r.discoveredNew, 6)}`,
    r.lastDiscovery ? `Watchlist ${r.lastDiscovery.watchlist} · near-graduation ${r.lastDiscovery.hotCurve} · fresh graduates ${r.lastDiscovery.freshGraduates}` : "",
    `Checked ${r.candidates} → snapshots ${r.snapshots} (no SOL pair ${r.noPair})`,
    `Filtered out: ${filtered} rejections — ${top(r.filtered)}`,
    `Scored (passed filters): ${r.scored} · below threshold ${r.belowThreshold}`,
    `Waiting/blocked: ${top(r.awaitingConfirmation)}`,
    `Confirmed signals: ${r.confirmed}`,
    `Rejected — safety: ${top(r.safetyRejected)} · quotes: ${top(r.quoteRejected)} · sizing: ${top(r.sizingSkipped)}`,
    `<b>Executed: ${r.executed}</b>${Object.keys(r.entryFailed).length ? ` · failed entries: ${top(r.entryFailed)}` : ""}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function formatExperiment(rows: Awaited<ReturnType<typeof experimentReport>>): string {
  const lines = ["<b>Strategy comparison (shadow paper books, same market data)</b>"];
  for (const r of rows) {
    const hours = (Date.now() - Date.parse(r.startedAt)) / 3_600_000;
    lines.push(
      "",
      `<b>${r.variant}</b> — ${hours.toFixed(1)}h`,
      `Net P&L: ${BigInt(r.netPnlLamports) >= 0n ? "+" : ""}${formatAsset(BigInt(r.netPnlLamports), "SOL")} (${r.returnPct}%) · realized ${formatAsset(BigInt(r.realizedLamports), "SOL")}`,
      `Trades: ${r.entries} entries (${(r.entries / Math.max(hours, 1 / 60)).toFixed(2)}/h), ${r.closed} closed, win rate ${r.winRatePct}%, avg hold ${r.avgHoldMinutes}m`,
      `Execution failures: ${r.entryFailures} entries, ${r.exitFailures} exits · open now: ${r.open.length}`,
      `Funnel: ${r.funnel.scored} scored → ${r.funnel.confirmed} confirmed → ${r.funnel.executed} executed`,
    );
  }
  lines.push("", "<i>Paper fills on real quotes with extra slippage and random failures. Not a promise of live results.</i>");
  return lines.join("\n");
}
