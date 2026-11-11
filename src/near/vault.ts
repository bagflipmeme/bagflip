/**
 * Client for the BAGFLIP vault contract (contracts/vault).
 *
 * RpcVault  — the real contract on NEAR. Views via RPC; operator calls are signed with the OPERATOR
 *             key (ideally a function-call key restricted to the vault) and persisted before broadcast.
 * SimVault  — an in-process model of the same rules (time-locked AUTO_HUNT, veto windows, per-epoch
 *             claim sets, rolling 24h trading cap, pause). Used in development, paper mode and tests,
 *             so every environment exercises the same flow the contract enforces.
 */
import type { Clock } from "../shared/time.ts";
import type { NearRpc, RawTxStatus } from "./rpc.ts";
import type { NearSigner } from "./signer.ts";
import { TGAS } from "./signer.ts";
import { verifyProof as verifyLeaf } from "../distribution/merkle.ts";

export type VaultMode = "Inactive" | "Distribute" | "AutoHunt";

export interface VaultStatus {
  mode: VaultMode;
  effective_mode: VaultMode;
  mode_cycle: string;
  pending_mode: { cycle_id: string; snapshot_hash: string; eta_ns: string } | null;
  paused: boolean;
  reserved_for_claims: string;
  free_balance: string;
  hunt_used_24h: string;
  hunt_remaining_24h: string;
  last_epoch: number;
  seats_filled?: number;
  eligible_seats?: number;
  veto_votes_required?: number;
  admin_votes_required?: number;
}

export interface VaultSeat {
  account_id: string;
  balance: string;
  since_ns: string;
}

export interface VaultDistribution {
  epoch: number;
  root: string;
  total: string;
  claimed: string;
  data_hash: string;
  proposed_ns: string;
  activates_ns: string;
  vetoed: boolean;
}

export interface VaultCall {
  method: string;
  args: Record<string, unknown>;
  gas?: bigint;
}

export interface VaultTx {
  hash: string;
  signed: string;
}

export interface VaultEvent {
  event: string;
  data: Record<string, unknown>;
}

export interface VaultOutcome {
  state: "success" | "failure" | "pending" | "unknown" | "expired";
  events: VaultEvent[];
  error?: string;
}

export interface VaultPort {
  readonly simulated: boolean;
  readonly accountId: string;
  readonly canSign: boolean;
  status(): Promise<VaultStatus>;
  distribution(epoch: number): Promise<VaultDistribution | null>;
  isClaimed(epoch: number, accountId: string): Promise<boolean>;
  /** Holder Council seats (top holders, contested on chain). */
  seats(): Promise<VaultSeat[]>;
  /** Sign an operator call without sending it (persist the result first). */
  prepare(call: VaultCall): Promise<VaultTx>;
  /** Broadcast (idempotent for the same bytes) and wait for the final outcome. */
  send(tx: VaultTx): Promise<VaultOutcome>;
  /** Final outcome of a previously prepared tx; "expired" = provably never landed. */
  outcome(tx: VaultTx): Promise<VaultOutcome>;
}

export function vaultEvents(raw: RawTxStatus, vault: string): VaultEvent[] {
  const out: VaultEvent[] = [];
  for (const r of raw.receipts_outcome ?? []) {
    if (r.outcome.executor_id !== vault) continue;
    for (const l of r.outcome.logs) {
      if (!l.startsWith("EVENT_JSON:")) continue;
      try {
        const e = JSON.parse(l.slice(11)) as { standard: string; event: string; data: Record<string, unknown>[] };
        if (e.standard === "bagflip_vault") for (const d of e.data) out.push({ event: e.event, data: d });
      } catch {
        /* ignore */
      }
    }
  }
  return out;
}

function firstFailure(raw: RawTxStatus): string | undefined {
  for (const r of raw.receipts_outcome ?? []) {
    const f = r.outcome.status?.Failure;
    if (f) return JSON.stringify(f).slice(0, 300);
  }
  return raw.status?.Failure ? JSON.stringify(raw.status.Failure).slice(0, 300) : undefined;
}

export class RpcVault implements VaultPort {
  readonly simulated = false;
  readonly accountId: string;
  private rpc: NearRpc;
  private signer?: NearSigner;
  constructor(rpc: NearRpc, accountId: string, signer?: NearSigner) {
    this.rpc = rpc;
    this.accountId = accountId;
    this.signer = signer;
  }
  get canSign() {
    return !!this.signer;
  }
  status() {
    return this.rpc.viewAt<VaultStatus>(this.accountId, "get_status", {});
  }
  distribution(epoch: number) {
    return this.rpc.viewAt<VaultDistribution | null>(this.accountId, "get_distribution", { epoch });
  }
  isClaimed(epoch: number, accountId: string) {
    return this.rpc.viewAt<boolean>(this.accountId, "is_claimed", { epoch, account_id: accountId });
  }
  seats() {
    return this.rpc.viewAt<VaultSeat[]>(this.accountId, "get_seats", {});
  }
  async prepare(call: VaultCall): Promise<VaultTx> {
    if (!this.signer) throw new Error("vault operator key not configured (LIVE_TRANSFERS_ENABLED=false)");
    const s = await this.signer.sign(this.accountId, [{ type: "functionCall", method: call.method, args: call.args, gas: call.gas ?? 150n * TGAS, deposit: 0n }]);
    return { hash: s.hash, signed: s.base64 };
  }
  private toOutcome(raw: RawTxStatus | undefined, state: string): VaultOutcome {
    if (!raw) return { state: state as VaultOutcome["state"], events: [] };
    const err = firstFailure(raw);
    return { state: err ? "failure" : (state as VaultOutcome["state"]), events: vaultEvents(raw, this.accountId), error: err };
  }
  async send(tx: VaultTx): Promise<VaultOutcome> {
    try {
      const r = await this.rpc.sendSigned(tx.signed);
      return this.toOutcome(r.raw, r.state);
    } catch (e) {
      if (/Expired|InvalidNonce/i.test(String(e))) return this.outcome(tx);
      throw e;
    }
  }
  async outcome(tx: VaultTx): Promise<VaultOutcome> {
    const s = await this.rpc.txStatus(tx.hash, this.signer?.accountId ?? this.accountId);
    if (s.state === "success" || s.state === "failure") return this.toOutcome(s.raw, s.state);
    // Unknown: re-broadcast the same bytes; an Expired rejection proves it never landed.
    try {
      const r = await this.rpc.sendSigned(tx.signed);
      return this.toOutcome(r.raw, r.state);
    } catch (e) {
      if (/Expired/i.test(String(e))) return { state: "expired", events: [] };
      if (/InvalidNonce/i.test(String(e))) {
        const again = await this.rpc.txStatus(tx.hash, this.signer?.accountId ?? this.accountId);
        return again.state === "unknown" ? { state: "expired", events: [] } : this.toOutcome(again.raw, again.state);
      }
      throw e;
    }
  }
}

// ───────────────────────────── simulated vault ─────────────────────────────

const NS = 1_000_000n;
const DAY_MS = 86_400_000;

export interface SimVaultConfig {
  modeDelayMs: number;
  distributionDelayMs: number;
  dailyHuntCap: bigint;
  seatsMax?: number;
  minSeatBalance?: bigint;
  /** Accounts that can never hold a seat (vault/token/operator added automatically by the caller). */
  excluded?: string[];
  /** Current token balance, like the contract's ft_balance_of cross-call. */
  balanceOf?: (accountId: string) => Promise<bigint>;
}

/** Faithful in-memory model of the contract's rules (balances are enforced by the BAGFLIP ledger). */
export class SimVault implements VaultPort {
  readonly simulated = true;
  readonly canSign = true;
  readonly accountId: string;
  private clock: Clock;
  private cfg: SimVaultConfig;
  mode: VaultMode = "Inactive";
  modeCycle = "";
  pending: { cycle_id: string; snapshot_hash: string; eta: number } | null = null;
  paused = false;
  lastEpoch = 0;
  reserved = 0n;
  dists = new Map<number, VaultDistribution>();
  claimed = new Set<string>();
  window: { at: number; amount: bigint }[] = [];
  seatList: VaultSeat[] = [];
  private txs = new Map<string, { call: VaultCall; result?: VaultOutcome }>();
  private n = 0;

  constructor(accountId: string, clock: Clock, cfg: SimVaultConfig) {
    this.accountId = accountId;
    this.clock = clock;
    this.cfg = cfg;
  }

  private now() {
    return this.clock.now().getTime();
  }
  private effective(): VaultMode {
    return this.pending && !this.paused && this.now() >= this.pending.eta ? "AutoHunt" : this.mode;
  }
  private materialize() {
    if (this.pending && !this.paused && this.now() >= this.pending.eta) {
      this.mode = "AutoHunt";
      this.modeCycle = this.pending.cycle_id;
      this.pending = null;
    }
  }
  private used() {
    const now = this.now();
    return this.window.filter((w) => now - w.at < DAY_MS).reduce((s, w) => s + w.amount, 0n);
  }

  async status(): Promise<VaultStatus> {
    return {
      mode: this.mode,
      effective_mode: this.effective(),
      mode_cycle: this.modeCycle,
      pending_mode: this.pending ? { cycle_id: this.pending.cycle_id, snapshot_hash: this.pending.snapshot_hash, eta_ns: (BigInt(this.pending.eta) * NS).toString() } : null,
      paused: this.paused,
      reserved_for_claims: this.reserved.toString(),
      free_balance: "0",
      hunt_used_24h: this.used().toString(),
      hunt_remaining_24h: (this.cfg.dailyHuntCap > this.used() ? this.cfg.dailyHuntCap - this.used() : 0n).toString(),
      last_epoch: this.lastEpoch,
    };
  }
  async distribution(epoch: number) {
    return this.dists.get(epoch) ?? null;
  }
  async isClaimed(epoch: number, accountId: string) {
    return this.claimed.has(`${epoch}:${accountId}`);
  }
  async seats() {
    return this.seatList.map((x) => ({ ...x }));
  }
  async prepare(call: VaultCall): Promise<VaultTx> {
    const hash = `sim-vault-${++this.n}-${call.method}`;
    this.txs.set(hash, { call });
    return { hash, signed: hash };
  }
  async send(tx: VaultTx): Promise<VaultOutcome> {
    const t = this.txs.get(tx.hash);
    if (!t) return { state: "expired", events: [] };
    if (!t.result) {
      try {
        t.result = { state: "success", events: await this.exec(t.call) };
      } catch (e) {
        t.result = { state: "failure", events: [], error: e instanceof Error ? e.message : String(e) };
      }
    }
    return t.result;
  }
  async outcome(tx: VaultTx) {
    return this.send(tx);
  }

  /** Council action reaching the veto threshold (tests / dev): veto a pending list. */
  vetoDistribution(epoch: number) {
    const d = this.dists.get(epoch);
    if (!d || d.vetoed || this.now() * 1 >= Number(BigInt(d.activates_ns) / NS)) throw new Error("cannot veto");
    d.vetoed = true;
    this.reserved -= BigInt(d.total) - BigInt(d.claimed);
  }
  vetoMode() {
    if (!this.pending || this.now() >= this.pending.eta) throw new Error("no pending mode");
    this.pending = null;
  }

  private async exec(c: VaultCall): Promise<VaultEvent[]> {
    const a = c.args as Record<string, any>;
    const now = this.now();
    switch (c.method) {
      case "propose_mode": {
        this.materialize();
        if (a.mode === "AutoHunt") {
          if (this.mode === "AutoHunt") {
            this.modeCycle = a.cycle_id;
            return [{ event: "mode_continued", data: a }];
          }
          if (!this.pending) {
            if (this.paused) throw new Error("vault is paused");
            this.pending = { cycle_id: a.cycle_id, snapshot_hash: a.snapshot_hash, eta: now + this.cfg.modeDelayMs };
            return [{ event: "mode_proposed", data: { ...a, eta_ns: (BigInt(this.pending.eta) * NS).toString() } }];
          }
          return [];
        }
        this.pending = null;
        this.mode = a.mode;
        this.modeCycle = a.cycle_id;
        return [{ event: "mode_applied", data: a }];
      }
      case "propose_distribution": {
        if (this.paused) throw new Error("vault is paused");
        if (a.epoch <= this.lastEpoch) throw new Error("epoch must increase");
        const d: VaultDistribution = {
          epoch: a.epoch,
          root: a.root,
          total: String(a.total),
          claimed: "0",
          data_hash: a.data_hash,
          proposed_ns: (BigInt(now) * NS).toString(),
          activates_ns: (BigInt(now + this.cfg.distributionDelayMs) * NS).toString(),
          vetoed: false,
        };
        this.dists.set(a.epoch, d);
        this.lastEpoch = a.epoch;
        this.reserved += BigInt(a.total);
        return [{ event: "distribution_proposed", data: d as never }];
      }
      case "fund_trading": {
        if (this.paused) throw new Error("vault is paused");
        this.materialize();
        if (this.mode !== "AutoHunt") throw new Error("mode is not AUTO_HUNT");
        const amt = BigInt(a.amount);
        if (this.used() + amt > this.cfg.dailyHuntCap) throw new Error("daily trading cap exceeded");
        this.window.push({ at: now, amount: amt });
        return [{ event: "trading_fund_requested", data: a }, { event: "trading_funded", data: a }];
      }
      case "claim_many": {
        if (this.paused) throw new Error("vault is paused");
        const acct = a.account_id as string;
        const items = a.items as { epoch: number; amount: string; proof: string[] }[];
        const seen = new Set<number>();
        let total = 0n;
        for (const it of items) {
          const d = this.dists.get(it.epoch);
          if (!d) throw new Error("unknown epoch");
          if (d.vetoed) throw new Error("distribution was vetoed");
          if (now < Number(BigInt(d.activates_ns) / NS)) throw new Error("distribution still in its veto window");
          if (this.claimed.has(`${it.epoch}:${acct}`) || seen.has(it.epoch)) throw new Error("already claimed");
          if (!verifyLeaf(d.root, BigInt(it.epoch), acct, BigInt(it.amount), it.proof)) throw new Error("invalid proof");
          if (BigInt(d.claimed) + BigInt(it.amount) > BigInt(d.total)) throw new Error("exceeds distribution total");
          seen.add(it.epoch);
        }
        for (const it of items) {
          const d = this.dists.get(it.epoch)!;
          d.claimed = (BigInt(d.claimed) + BigInt(it.amount)).toString();
          this.claimed.add(`${it.epoch}:${acct}`);
          this.reserved -= BigInt(it.amount);
          total += BigInt(it.amount);
        }
        return [{ event: "claim_sent", data: { account_id: acct, amount: total.toString() } }, { event: "claimed", data: { account_id: acct } }];
      }
      case "unwrap":
        return [];
      case "claim_seat": {
        // Mirrors the contract: balances read at call time; the larger CURRENT holder takes the seat.
        const cand = a.candidate as string;
        const max = this.cfg.seatsMax ?? 10;
        const min = this.cfg.minSeatBalance ?? 1n;
        if ((this.cfg.excluded ?? []).includes(cand) || cand === this.accountId) throw new Error("this account cannot hold a seat");
        if (this.seatList.some((x) => x.account_id === cand)) throw new Error("already seated");
        const bal = this.cfg.balanceOf ? await this.cfg.balanceOf(cand) : 0n;
        const since = (BigInt(now) * NS).toString();
        if (!a.replace) {
          if (this.seatList.length >= max) throw new Error("council is full: name a seat to contest");
          if (bal < min) return [{ event: "seat_rejected", data: { candidate: cand, balance: bal.toString() } }];
          this.seatList.push({ account_id: cand, balance: bal.toString(), since_ns: since });
          return [{ event: "seat_won", data: { account_id: cand } }];
        }
        const idx = this.seatList.findIndex((x) => x.account_id === a.replace);
        if (idx < 0) throw new Error("that account does not hold a seat");
        const tb = this.cfg.balanceOf ? await this.cfg.balanceOf(a.replace) : 0n;
        if (bal <= tb || bal < min) return [{ event: "seat_rejected", data: { candidate: cand, balance: bal.toString(), target: a.replace } }];
        this.seatList[idx] = { account_id: cand, balance: bal.toString(), since_ns: since };
        return [{ event: "seat_won", data: { seat: { account_id: cand }, replaced: a.replace } }];
      }
      default:
        throw new Error(`unknown vault method ${c.method}`);
    }
  }
}

