/**
 * NEP-413 signed-message verification (https://github.com/near/NEPs/blob/master/neps/nep-0413.md).
 *
 * The wallet signs sha256(borsh(u32 tag = 2^31 + 413) || borsh(Payload)) where
 * Payload = { message: string, nonce: [u8; 32], recipient: string, callbackUrl: Option<string> }.
 *
 * Signature validity alone is not enough: the backend must also check that
 * the public key is a FULL ACCESS key of the claimed account on chain, that
 * the nonce/message/recipient match an unused, unexpired challenge.
 */
import { createHash } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import bs58 from "bs58";

const TAG = 2 ** 31 + 413;

function u32(n: number) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
}
function borshString(s: string) {
  const bytes = Buffer.from(s, "utf8");
  return Buffer.concat([u32(bytes.length), bytes]);
}

export function nep413Hash(p: { message: string; nonce: Uint8Array; recipient: string; callbackUrl?: string | null }): Uint8Array {
  if (p.nonce.length !== 32) throw new Error("NEP-413 nonce must be 32 bytes");
  const parts = [u32(TAG), borshString(p.message), Buffer.from(p.nonce), borshString(p.recipient)];
  if (p.callbackUrl) parts.push(Buffer.from([1]), borshString(p.callbackUrl));
  else parts.push(Buffer.from([0]));
  return new Uint8Array(createHash("sha256").update(Buffer.concat(parts)).digest());
}

export function parseEd25519PublicKey(pk: string): Uint8Array {
  const raw = pk.startsWith("ed25519:") ? pk.slice(8) : pk;
  const bytes = bs58.decode(raw);
  if (bytes.length !== 32) throw new Error("Invalid ed25519 public key");
  return bytes;
}

/** Signatures arrive base64 (wallet-selector standard) or base58/"ed25519:"-prefixed. */
export function decodeSignature(sig: string): Uint8Array {
  const s = sig.startsWith("ed25519:") ? sig.slice(8) : sig;
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(s) && s.length === 88) {
    const b = Buffer.from(s, "base64");
    if (b.length === 64) return new Uint8Array(b);
  }
  const b58 = bs58.decode(s);
  if (b58.length !== 64) throw new Error("Invalid ed25519 signature length");
  return b58;
}

export function verifyNep413Signature(p: {
  message: string;
  nonce: Uint8Array;
  recipient: string;
  callbackUrl?: string | null;
  publicKey: string;
  signature: string;
}): boolean {
  try {
    const hash = nep413Hash(p);
    return ed25519.verify(decodeSignature(p.signature), hash, parseEd25519PublicKey(p.publicKey));
  } catch {
    return false;
  }
}

/** Helper used by tests and the dev simulator: sign like a wallet would. */
export function signNep413(secretKey: Uint8Array, p: { message: string; nonce: Uint8Array; recipient: string; callbackUrl?: string | null }) {
  const sig = ed25519.sign(nep413Hash(p), secretKey);
  return Buffer.from(sig).toString("base64");
}

export function publicKeyString(secretKey: Uint8Array): string {
  return `ed25519:${bs58.encode(ed25519.getPublicKey(secretKey))}`;
}
