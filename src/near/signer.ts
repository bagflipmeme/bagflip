/**
 * Treasury transaction signing (live mode only). Transactions are signed and
 * persisted *before* broadcast; the hash is deterministic, so a crash between
 * "signed" and "confirmed" is recovered by re-broadcasting the same bytes or
 * querying the hash — never by signing a second payment.
 */
import { createHash } from "node:crypto";
import { KeyPair } from "@near-js/crypto";
import { actionCreators, createTransaction, encodeTransaction, Signature, SignedTransaction } from "@near-js/transactions";
import { baseDecode, baseEncode } from "@near-js/utils";
import type { NearRpc } from "./rpc.ts";

export type NearAction =
  | { type: "transfer"; deposit: bigint }
  | { type: "functionCall"; method: string; args: Record<string, unknown>; gas: bigint; deposit: bigint };

export interface SignedNearTx {
  hash: string;
  base64: string;
  signerId: string;
  receiverId: string;
}

export class NearSigner {
  private kp: KeyPair;
  private lastNonce = 0n;
  private rpc: NearRpc;
  public readonly accountId: string;
  constructor(rpc: NearRpc, accountId: string, privateKey: string) {
    this.rpc = rpc;
    this.accountId = accountId;
    this.kp = KeyPair.fromString(privateKey as `ed25519:${string}`);
  }

  get publicKey() {
    return this.kp.getPublicKey().toString();
  }

  async sign(receiverId: string, actions: NearAction[]): Promise<SignedNearTx> {
    const pub = this.kp.getPublicKey();
    const ak = await this.rpc.accessKey(this.accountId, pub.toString());
    if (!ak) throw new Error(`Signer key is not registered on ${this.accountId}`);
    // Never reuse a nonce: the chain view can lag a just-broadcast transaction.
    const nonce = (ak.nonce > this.lastNonce ? ak.nonce : this.lastNonce) + 1n;
    this.lastNonce = nonce;
    const tx = createTransaction(
      this.accountId,
      pub,
      receiverId,
      nonce,
      actions.map((a) =>
        a.type === "transfer" ? actionCreators.transfer(a.deposit) : actionCreators.functionCall(a.method, a.args, a.gas, a.deposit),
      ),
      baseDecode(ak.blockHash),
    );
    const digest = createHash("sha256").update(encodeTransaction(tx)).digest();
    const sig = this.kp.sign(new Uint8Array(digest));
    const signed = new SignedTransaction({ transaction: tx, signature: new Signature({ keyType: pub.keyType, data: sig.signature }) });
    return { hash: baseEncode(digest), base64: Buffer.from(signed.encode()).toString("base64"), signerId: this.accountId, receiverId };
  }
}

export const TGAS = 1_000_000_000_000n;
export const ONE_YOCTO = 1n;
