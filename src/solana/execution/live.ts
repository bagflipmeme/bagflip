/**
 * LIVE Solana execution for the trading wallet. Only constructed when
 * BAGFLIP_ENV=live AND LIVE_TRADING_ENABLED=true AND the trading key is present.
 *
 * Venues:
 *  - Jupiter Swap V2 (/order + /execute): routes Pump.fun bonding-curve tokens,
 *    PumpSwap and other AMMs.
 *  - PumpPortal Local Transaction API (POST /api/trade-local, pool=auto): returns
 *    an unsigned tx we sign locally and send through our own RPC. Used when
 *    Jupiter has no route (e.g. very fresh curve tokens). 0.5% PumpPortal fee.
 * Every transaction is simulated before broadcast; settlement amounts are read
 * from the confirmed transaction's balance changes.
 */
import { PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { JupiterClient, deserializeTx } from "./jupiter.ts";
import {
  PrepareError,
  BASE_FEE_LAMPORTS,
  type ExecutionAdapter,
  type OrderIntent,
  type PreparedOrder,
  type SettleResult,
  type SwapQuote,
} from "./types.ts";
import { SolanaChain, TradingKeypair, txSignature, WSOL_MINT } from "../rpc.ts";
import type { Logger } from "../../shared/log.ts";

export class LiveExecution implements ExecutionAdapter {
  readonly mode = "live" as const;
  private sol: SolanaChain;
  private kp: TradingKeypair;
  private jup: JupiterClient;
  private opts: { venue: "auto" | "jupiter" | "pumpportal"; pumpPortalBase: string; priorityFeeLamports: number; log: Logger };
  constructor(
    sol: SolanaChain,
    kp: TradingKeypair,
    jup: JupiterClient,
    opts: { venue: "auto" | "jupiter" | "pumpportal"; pumpPortalBase: string; priorityFeeLamports: number; log: Logger },
  ) {
    this.sol = sol;
    this.kp = kp;
    this.jup = jup;
    this.opts = opts;}

  quoteBuy(mint: string, lamports: bigint) {
    return this.jup.quote("buy", mint, lamports);
  }
  quoteSell(mint: string, tokens: bigint) {
    return this.jup.quote("sell", mint, tokens);
  }

  private async finish(tx: VersionedTransaction, via: string, expectedOut: bigint, minOut: bigint, extra: Record<string, unknown>, quote: unknown): Promise<PreparedOrder> {
    this.kp.sign(tx);
    const sim = await this.sol.simulate(tx);
    if (!sim.ok) throw new PrepareError(`simulation failed: ${JSON.stringify(sim.err)} ${(sim.logs ?? []).slice(-3).join(" | ")}`, "simulation_failed");
    const height = await this.sol.blockHeight();
    return {
      signature: txSignature(tx),
      lastValidBlockHeight: height + 150n,
      expectedOut,
      minOut,
      venue: via,
      payload: JSON.stringify({ via, signed: Buffer.from(tx.serialize()).toString("base64"), ...extra }),
      quote,
    };
  }

  async prepare(o: OrderIntent): Promise<PreparedOrder> {
    const venues = this.opts.venue === "auto" ? ["jupiter", "pumpportal"] : [this.opts.venue];
    let lastErr: unknown;
    for (const v of venues) {
      try {
        if (v === "jupiter") {
          const order = await this.jup.order({
            inputMint: o.side === "buy" ? WSOL_MINT : o.mint,
            outputMint: o.side === "buy" ? o.mint : WSOL_MINT,
            amount: o.amountIn,
            taker: this.kp.address,
            slippageBps: o.slippageBps,
          });
          if (!order?.transaction) throw new PrepareError("jupiter: no route", "no_route");
          const out = BigInt(order.outAmount);
          const min = order.otherAmountThreshold ? BigInt(order.otherAmountThreshold) : (out * BigInt(10_000 - o.slippageBps)) / 10_000n;
          return await this.finish(deserializeTx(order.transaction), "jupiter", out, min, { requestId: order.requestId }, order);
        }
        // PumpPortal local transaction
        let amount: string;
        let denominatedInSol: string;
        if (o.side === "buy") {
          amount = (Number(o.amountIn) / 1e9).toFixed(9);
          denominatedInSol = "true";
        } else {
          const held = await this.sol.tokenBalance(this.kp.address, o.mint);
          if (held === 0n) throw new PrepareError("no tokens held", "no_route");
          const pct = o.amountIn >= held ? 100 : Math.max(1, Math.floor(Number((o.amountIn * 10_000n) / held) / 100));
          amount = `${pct}%`;
          denominatedInSol = "false";
        }
        const res = await fetch(`${this.opts.pumpPortalBase}/api/trade-local`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            publicKey: this.kp.address,
            action: o.side,
            mint: o.mint,
            amount,
            denominatedInSol,
            slippage: Math.ceil(o.slippageBps / 100),
            priorityFee: this.opts.priorityFeeLamports / 1e9,
            pool: "auto",
          }),
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) throw new PrepareError(`pumpportal: HTTP ${res.status} ${res.statusText}`, "no_route");
        const tx = VersionedTransaction.deserialize(new Uint8Array(await res.arrayBuffer()));
        return await this.finish(tx, "pumpportal", 0n, 0n, {}, { pumpportal: { amount, denominatedInSol } });
      } catch (e) {
        lastErr = e;
        this.opts.log.warn("venue prepare failed", { venue: v, error: String(e) });
      }
    }
    throw lastErr instanceof PrepareError ? lastErr : new PrepareError(String(lastErr), "quote_failed");
  }

  async broadcast(p: PreparedOrder) {
    const payload = JSON.parse(p.payload) as { via: string; signed: string; requestId?: string };
    if (payload.via === "jupiter" && payload.requestId) {
      try {
        const r = await this.jup.execute(payload.signed, payload.requestId);
        if (r.status === "Success") return;
        this.opts.log.warn("jupiter execute non-success; settling from chain", { error: r.error, code: r.code });
        return;
      } catch (e) {
        this.opts.log.warn("jupiter execute failed; sending same signed tx via RPC", { error: String(e) });
      }
    }
    await this.sol.sendRaw(deserializeTx(payload.signed));
  }

  async settle(o: { signature: string; side: "buy" | "sell"; mint: string; lastValidBlockHeight: bigint | null; payload?: string }): Promise<SettleResult> {
    const st = await this.sol.signatureState(o.signature);
    if (st.state === "confirmed") {
      const s = await this.sol.settledSwap(o.signature, this.kp.address, o.mint);
      if (!s) return { state: "pending" };
      return {
        state: "confirmed",
        settlement:
          o.side === "buy"
            ? { sol: s.solDelta, tokens: s.tokenDelta, feeLamports: s.feeLamports, tokenDecimals: s.tokenDecimals }
            : { sol: -s.solDelta, tokens: -s.tokenDelta, feeLamports: s.feeLamports, tokenDecimals: s.tokenDecimals },
      };
    }
    if (st.state === "failed") {
      const s = await this.sol.settledSwap(o.signature, this.kp.address, o.mint).catch(() => null);
      return { state: "failed", feeLamports: s?.feeLamports ?? BASE_FEE_LAMPORTS, error: JSON.stringify(st.err) };
    }
    const h = await this.sol.blockHeight();
    if (o.lastValidBlockHeight !== null && h > o.lastValidBlockHeight + 50n) {
      // Blockhash expired and the signature is unknown: it can never land.
      const again = await this.sol.signatureState(o.signature);
      if (again.state === "not_found") return { state: "expired" };
      return { state: "pending" };
    }
    if (o.payload) {
      const payload = JSON.parse(o.payload) as { signed: string };
      await this.sol.sendRaw(deserializeTx(payload.signed)).catch(() => {});
    }
    return { state: "pending" };
  }

  solBalance() {
    return this.sol.balanceLamports(this.kp.address);
  }
  tokenBalance(mint: string) {
    return this.sol.tokenBalance(this.kp.address, mint);
  }

  async closeTokenAccount(mint: string) {
    const owner = this.kp.kp.publicKey;
    const accs = await this.sol.conn.getParsedTokenAccountsByOwner(owner, { mint: new PublicKey(mint) });
    const empty = accs.value.filter((a) => (a.account.data as { parsed: { info: { tokenAmount: { amount: string } } } }).parsed.info.tokenAmount.amount === "0");
    if (!empty.length) return null;
    const ixs = empty.map(
      (a) =>
        new TransactionInstruction({
          programId: a.account.owner, // Token or Token-2022 program
          keys: [
            { pubkey: a.pubkey, isSigner: false, isWritable: true },
            { pubkey: owner, isSigner: false, isWritable: true },
            { pubkey: owner, isSigner: true, isWritable: false },
          ],
          data: Buffer.from([9]), // CloseAccount
        }),
    );
    const lamports = empty.reduce((s, a) => s + BigInt(a.account.lamports), 0n);
    const { blockhash } = await this.sol.latestBlockhash();
    const tx = new VersionedTransaction(new TransactionMessage({ payerKey: owner, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message());
    this.kp.sign(tx);
    const sim = await this.sol.simulate(tx);
    if (!sim.ok) return null;
    const sig = await this.sol.sendRaw(tx);
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      const st = await this.sol.signatureState(sig);
      if (st.state === "confirmed") return { signature: sig, lamports: lamports - BASE_FEE_LAMPORTS };
      if (st.state === "failed") return null;
    }
    return null;
  }
}

export type { SwapQuote };
