/**
 * Depositors move funds into a 1Click deposit address on the origin chain.
 * Two-phase: prepare() signs and returns a deterministic hash which the
 * workflow persists BEFORE broadcast(); a crash in between is recovered by
 * re-broadcasting the identical signed bytes (cannot double-spend).
 */
import { VersionedTransaction } from "@solana/web3.js";
import { TGAS } from "../near/signer.ts";
import type { VaultPort } from "../near/vault.ts";
import { buildSolTransfer, txSignature, type SolanaChain, type TradingKeypair } from "../solana/rpc.ts";

export interface PreparedDeposit {
  hash: string;
  signed: string;
  lastValidBlockHeight?: bigint;
}

export type LandedState = "landed" | "failed" | "pending" | "not_landed";

export interface Depositor {
  readonly simulated: boolean;
  prepare(depositAddress: string, amount: bigint): Promise<PreparedDeposit>;
  broadcast(p: PreparedDeposit): Promise<void>;
  /** Whether the deposit tx landed. "not_landed" must be definitive (expired). */
  state(p: PreparedDeposit): Promise<{ state: LandedState; feePaid: bigint }>;
}

export class VirtualDepositor implements Depositor {
  readonly simulated = true;
  private n = 0;
  async prepare(depositAddress: string): Promise<PreparedDeposit> {
    return { hash: `sim-tx-${depositAddress}-${++this.n}`, signed: "" };
  }
  async broadcast() {}
  async state() {
    return { state: "landed" as const, feePaid: 0n };
  }
}

/** NEP-145 registration the vault attaches for a fresh 1Click deposit address on wrap.near. */
export const WRAP_STORAGE_DEPOSIT = 1_250_000_000_000_000_000_000n;

/**
 * Vault → 1Click: the operator asks the vault to `fund_trading`. The vault itself enforces the mode
 * (AUTO_HUNT, time-locked), the rolling 24h cap and its unreserved balance, then wraps and transfers
 * in one atomic wrap.near receipt. The operator pays gas; the vault pays only the storage deposit.
 */
export class VaultDepositor implements Depositor {
  readonly simulated: boolean;
  private vault: VaultPort;
  constructor(vault: VaultPort) {
    this.vault = vault;
    this.simulated = vault.simulated;
  }

  async prepare(depositAddress: string, amount: bigint): Promise<PreparedDeposit> {
    const tx = await this.vault.prepare({
      method: "fund_trading",
      args: { amount: amount.toString(), deposit_address: depositAddress, quote_ref: depositAddress.slice(0, 64) },
      gas: 120n * TGAS,
    });
    return { hash: tx.hash, signed: tx.signed };
  }

  async broadcast(p: PreparedDeposit) {
    await this.vault.send({ hash: p.hash, signed: p.signed });
  }

  async state(p: PreparedDeposit) {
    const o = await this.vault.outcome({ hash: p.hash, signed: p.signed });
    if (o.state === "expired") return { state: "not_landed" as const, feePaid: 0n };
    if (o.state === "pending" || o.state === "unknown") return { state: "pending" as const, feePaid: 0n };
    if (o.state === "success" && o.events.some((e) => e.event === "trading_funded")) return { state: "landed" as const, feePaid: WRAP_STORAGE_DEPOSIT };
    // Contract rejected (cap, mode, paused) or the wrap.near receipt reverted: nothing left the vault.
    return { state: "failed" as const, feePaid: 0n };
  }
}

/** Trading wallet → 1Click: native SOL transfer to the deposit address. */
export class SolTradingDepositor implements Depositor {
  readonly simulated = false;
  private sol: SolanaChain;
  private kp: TradingKeypair;
  constructor(sol: SolanaChain, kp: TradingKeypair) {
    this.sol = sol;
    this.kp = kp;}

  async prepare(depositAddress: string, amount: bigint): Promise<PreparedDeposit> {
    const { tx, lastValidBlockHeight } = await buildSolTransfer(this.sol, this.kp.kp.publicKey, depositAddress, amount);
    this.kp.sign(tx);
    return { hash: txSignature(tx), signed: Buffer.from(tx.serialize()).toString("base64"), lastValidBlockHeight: BigInt(lastValidBlockHeight) };
  }

  async broadcast(p: PreparedDeposit) {
    await this.sol.sendRaw(VersionedTransaction.deserialize(Buffer.from(p.signed, "base64")));
  }

  async state(p: PreparedDeposit) {
    const s = await this.sol.signatureState(p.hash);
    if (s.state === "confirmed") return { state: "landed" as const, feePaid: 5000n };
    if (s.state === "failed") return { state: "failed" as const, feePaid: 5000n };
    const h = await this.sol.blockHeight();
    if (p.lastValidBlockHeight !== undefined && h > p.lastValidBlockHeight + 150n) return { state: "not_landed" as const, feePaid: 0n };
    await this.broadcast(p).catch(() => {});
    return { state: "pending" as const, feePaid: 0n };
  }
}

