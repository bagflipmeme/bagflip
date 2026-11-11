/**
 * Reconciliation: compare the ledger with what the chains actually hold.
 * A shortfall pauses trading (RiskController reads trading_health.reconcile).
 * Surpluses (someone sent SOL to the trading wallet, rent refunds) are
 * reported but never auto-credited as trading capital.
 */
import type { Db } from "../db/index.ts";
import { setState } from "../db/index.ts";
import type { Config } from "../shared/config.ts";
import type { Clock } from "../shared/time.ts";
import type { NearChain } from "../near/chain.ts";
import type { ExecutionAdapter } from "../solana/execution/types.ts";
import { A, balance, verifyLedgerIntegrity } from "../treasury/ledger.ts";
import { getHealth } from "./risk.ts";
import { notify } from "../shared/outbox.ts";
import { formatAsset } from "../shared/money.ts";

const SOL_TOLERANCE = 3_000_000n; // 0.003 SOL: fee/rent rounding between ledger and chain
const NEAR_TOLERANCE = 50_000_000_000_000_000_000n; // 0.05 NEAR: gas and storage noise

export interface ReconcileReport {
  ok: boolean;
  problems: string[];
  notes: string[];
}

export async function reconcile(db: Db, cfg: Config, clock: Clock, exec: ExecutionAdapter, near: NearChain): Promise<ReconcileReport> {
  const problems: string[] = [];
  const notes: string[] = [];

  const integrity = await verifyLedgerIntegrity(db);
  problems.push(...integrity.problems);

  if (exec.mode === "live") {
    const ledgerSol = await balance(db, A.tradingAvailable, "SOL");
    const walletSol = await exec.solBalance();
    if (walletSol + SOL_TOLERANCE < ledgerSol) problems.push(`trading wallet holds ${formatAsset(walletSol, "SOL")} but ledger expects ${formatAsset(ledgerSol, "SOL")}`);
    else if (walletSol > ledgerSol + SOL_TOLERANCE) notes.push(`trading wallet has ${formatAsset(walletSol - ledgerSol, "SOL")} unattributed surplus (not tradable)`);

    const pos = await db.query<{ id: string; mint: string; token_amount: string }>("SELECT id, mint, token_amount FROM trading_positions WHERE status IN ('open','closing')");
    for (const p of pos.rows) {
      const onChain = await exec.tokenBalance(p.mint);
      const recorded = BigInt(p.token_amount);
      if (onChain * 100n < recorded * 99n) problems.push(`position ${p.id} records ${recorded} tokens but wallet holds ${onChain}`);
    }
  }

  if (!near.simulated && cfg.BAGFLIP_ENV === "live" && cfg.TREASURY_NEAR_ADDRESS) {
    const held = await near.nearHoldings(cfg.TREASURY_NEAR_ADDRESS);
    const owed = (await balance(db, A.available, "NEAR")) + (await balance(db, A.distPool, "NEAR")) + (await balance(db, A.claimable, "NEAR"));
    const total = held.native + held.wrapped;
    if (total + NEAR_TOLERANCE < owed) problems.push(`treasury holds ${formatAsset(total, "NEAR")} but ledger expects ${formatAsset(owed, "NEAR")}`);
  }

  const ok = problems.length === 0;
  const h = await getHealth(db);
  const wasOk = h.reconcile?.ok !== false;
  h.reconcile = { ok, at: clock.now().toISOString(), problems };
  await setState(db, "trading_health", h);
  await setState(db, "reconcile_report", { ok, problems, notes, at: clock.now().toISOString() });
  if (!ok && wasOk) {
    await notify(db, clock, `reconcile-fail:${clock.now().toISOString().slice(0, 13)}`, "failure", `⚠️ <b>Reconciliation failed</b> — new trades paused.\n${problems.slice(0, 3).join("\n")}`);
  }
  return { ok, problems, notes };
}
