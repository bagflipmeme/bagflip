/**
 * Solana access for the trading wallet. Built on @solana/web3.js 1.x.
 *
 * Settlement is always read back from the chain: the SOL and token amounts a
 * trade actually moved come from the confirmed transaction's pre/post
 * balances, never from a quote.
 */
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
  type Commitment,
} from "@solana/web3.js";
import bs58 from "bs58";

export const WSOL_MINT = "So11111111111111111111111111111111111111112";
export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

export interface SignatureState {
  state: "confirmed" | "failed" | "not_found";
  err?: unknown;
  slot?: number;
}

export interface SettledSwap {
  /** Lamports that left the wallet (positive) or arrived (negative), including fees. */
  solDelta: bigint;
  /** Token base units that arrived (positive) or left (negative) for `mint`. */
  tokenDelta: bigint;
  feeLamports: bigint;
  tokenDecimals: number | null;
}

export class SolanaChain {
  readonly conn: Connection;
  private commitment: Commitment;
  constructor(url: string, commitment: Commitment = "confirmed") {
    this.commitment = commitment;
    this.conn = new Connection(url, { commitment });
  }

  async balanceLamports(owner: string): Promise<bigint> {
    return BigInt(await this.conn.getBalance(new PublicKey(owner), this.commitment));
  }

  async blockHeight(): Promise<bigint> {
    return BigInt(await this.conn.getBlockHeight(this.commitment));
  }

  async latestBlockhash() {
    return this.conn.getLatestBlockhash(this.commitment);
  }

  async signatureState(sig: string): Promise<SignatureState> {
    const r = await this.conn.getSignatureStatuses([sig], { searchTransactionHistory: true });
    const s = r.value[0];
    if (!s) return { state: "not_found" };
    if (s.err) return { state: "failed", err: s.err, slot: s.slot };
    if (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized") return { state: "confirmed", slot: s.slot };
    return { state: "not_found" };
  }

  async simulate(tx: VersionedTransaction): Promise<{ ok: boolean; err?: unknown; logs?: string[] }> {
    const r = await this.conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: false, commitment: "processed" });
    return { ok: !r.value.err, err: r.value.err ?? undefined, logs: r.value.logs ?? undefined };
  }

  async sendRaw(tx: VersionedTransaction): Promise<string> {
    return this.conn.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 3 });
  }

  /** Read the real effect of a confirmed transaction on `owner`. */
  async settledSwap(sig: string, owner: string, mint: string): Promise<SettledSwap | null> {
    const tx = await this.conn.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    if (!tx?.meta) return null;
    const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses });
    let idx = -1;
    for (let i = 0; i < keys.length; i++) if (keys.get(i)?.toBase58() === owner) idx = i;
    if (idx < 0) return null;
    const solDelta = BigInt(tx.meta.preBalances[idx]!) - BigInt(tx.meta.postBalances[idx]!);
    const sumFor = (arr: typeof tx.meta.postTokenBalances) =>
      (arr ?? []).filter((b) => b.owner === owner && b.mint === mint).reduce((s, b) => s + BigInt(b.uiTokenAmount.amount), 0n);
    const decimals = (tx.meta.postTokenBalances ?? []).concat(tx.meta.preTokenBalances ?? []).find((b) => b.mint === mint)?.uiTokenAmount.decimals ?? null;
    return { solDelta, tokenDelta: sumFor(tx.meta.postTokenBalances) - sumFor(tx.meta.preTokenBalances), feeLamports: BigInt(tx.meta.fee), tokenDecimals: decimals };
  }

  async tokenBalance(owner: string, mint: string): Promise<bigint> {
    const r = await this.conn.getParsedTokenAccountsByOwner(new PublicKey(owner), { mint: new PublicKey(mint) });
    return r.value.reduce((s, a) => s + BigInt((a.account.data as { parsed: { info: { tokenAmount: { amount: string } } } }).parsed.info.tokenAmount.amount), 0n);
  }

  /** Mint safety facts: authorities, program, risky Token-2022 extensions. */
  async mintInfo(mint: string): Promise<{ program: string; decimals: number; mintAuthority: string | null; freezeAuthority: string | null; extensions: string[]; supply: bigint } | null> {
    const r = await this.conn.getParsedAccountInfo(new PublicKey(mint));
    const v = r.value;
    if (!v || !("parsed" in (v.data as object))) return null;
    const info = (v.data as { parsed: { info: Record<string, any> } }).parsed.info;
    return {
      program: v.owner.toBase58(),
      decimals: info.decimals,
      mintAuthority: info.mintAuthority ?? null,
      freezeAuthority: info.freezeAuthority ?? null,
      extensions: (info.extensions ?? []).map((e: { extension: string }) => e.extension),
      supply: BigInt(info.supply),
    };
  }

  /** Top token accounts with their owners (to measure holder concentration). */
  async largestHolders(mint: string): Promise<{ owner: string; amount: bigint }[]> {
    const largest = await this.conn.getTokenLargestAccounts(new PublicKey(mint));
    const addrs = largest.value.slice(0, 20).map((a) => a.address);
    const infos = await this.conn.getMultipleParsedAccounts(addrs);
    return infos.value.map((acc, i) => ({
      owner: (acc?.data as { parsed?: { info?: { owner?: string } } })?.parsed?.info?.owner ?? addrs[i]!.toBase58(),
      amount: BigInt(largest.value[i]!.amount),
    }));
  }
}

export class TradingKeypair {
  readonly kp: Keypair;
  constructor(secretBase58: string, expectedAddress: string) {
    this.kp = Keypair.fromSecretKey(bs58.decode(secretBase58));
    if (this.kp.publicKey.toBase58() !== expectedAddress) {
      throw new Error("SOLANA_TRADING_PRIVATE_KEY does not match TRADING_WALLET_ADDRESS");
    }
  }
  get address() {
    return this.kp.publicKey.toBase58();
  }
  sign(tx: VersionedTransaction): VersionedTransaction {
    tx.sign([this.kp]);
    return tx;
  }
}

export function txSignature(tx: VersionedTransaction): string {
  const s = tx.signatures[0];
  if (!s) throw new Error("unsigned transaction");
  return bs58.encode(s);
}

/** Native SOL transfer (used for bridge deposits back to NEAR). */
export async function buildSolTransfer(chain: SolanaChain, from: PublicKey, to: string, lamports: bigint) {
  const { blockhash, lastValidBlockHeight } = await chain.latestBlockhash();
  const msg = new TransactionMessage({
    payerKey: from,
    recentBlockhash: blockhash,
    instructions: [SystemProgram.transfer({ fromPubkey: from, toPubkey: new PublicKey(to), lamports: Number(lamports) })],
  }).compileToV0Message();
  return { tx: new VersionedTransaction(msg), lastValidBlockHeight };
}

export const solscanTx = (sig: string) => `https://solscan.io/tx/${sig}`;
export const solscanAccount = (a: string) => `https://solscan.io/account/${a}`;
export const nearblocksTx = (h: string) => `https://nearblocks.io/txns/${h}`;
export const nearblocksAccount = (a: string) => `https://nearblocks.io/address/${a}`;
