/**
 * Merkle payout lists, byte-for-byte identical to contracts/vault (shared vectors in
 * contracts/vault/test-vectors/merkle.json are checked by both test suites).
 *
 *   leaf = sha256(0x00 ‖ epoch u64 LE ‖ amount u128 LE ‖ account_id utf8)
 *   node = sha256(0x01 ‖ min(a,b) ‖ max(a,b))     (sorted pairs: proofs carry no direction bits)
 * Leaves are ordered by account id; an odd node at the end of a level is promoted unchanged.
 */
import { createHash } from "node:crypto";

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest();

export function leafHash(epoch: bigint, accountId: string, amount: bigint): Buffer {
  const e = Buffer.alloc(8);
  e.writeBigUInt64LE(epoch);
  const a = Buffer.alloc(16);
  a.writeBigUInt64LE(amount & 0xffff_ffff_ffff_ffffn, 0);
  a.writeBigUInt64LE(amount >> 64n, 8);
  return sha256(Buffer.concat([Buffer.from([0]), e, a, Buffer.from(accountId, "utf8")]));
}

export function nodeHash(x: Buffer, y: Buffer): Buffer {
  const [lo, hi] = Buffer.compare(x, y) <= 0 ? [x, y] : [y, x];
  return sha256(Buffer.concat([Buffer.from([1]), lo, hi]));
}

export interface PayoutLeaf {
  accountId: string;
  amount: bigint;
}

export interface PayoutTree {
  epoch: bigint;
  root: string;
  total: bigint;
  leaves: PayoutLeaf[];
  /** proofs[accountId] = hex sibling hashes */
  proofs: Map<string, string[]>;
  /** sha256 of the canonical JSON list (published for verification) */
  dataHash: string;
  canonical: string;
}

export function canonicalList(epoch: bigint, leaves: PayoutLeaf[]): string {
  return JSON.stringify({ epoch: epoch.toString(), payouts: leaves.map((l) => [l.accountId, l.amount.toString()]) });
}

export function buildPayoutTree(epoch: bigint, input: PayoutLeaf[]): PayoutTree {
  if (!input.length) throw new Error("empty payout list");
  const leaves = [...input].sort((a, b) => (a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0));
  for (let i = 1; i < leaves.length; i++) if (leaves[i]!.accountId === leaves[i - 1]!.accountId) throw new Error(`duplicate account ${leaves[i]!.accountId}`);
  let level = leaves.map((l) => leafHash(epoch, l.accountId, l.amount));
  // index path of each leaf through the levels
  const pos = leaves.map((_, i) => i);
  const proofs = new Map<string, string[]>(leaves.map((l) => [l.accountId, []]));
  while (level.length > 1) {
    const next: Buffer[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(i + 1 < level.length ? nodeHash(level[i]!, level[i + 1]!) : level[i]!);
    leaves.forEach((l, k) => {
      const p = pos[k]!;
      const sib = p ^ 1;
      if (sib < level.length) proofs.get(l.accountId)!.push(level[sib]!.toString("hex"));
      pos[k] = p >> 1;
    });
    level = next;
  }
  const canonical = canonicalList(epoch, leaves);
  return {
    epoch,
    root: level[0]!.toString("hex"),
    total: leaves.reduce((s, l) => s + l.amount, 0n),
    leaves,
    proofs,
    dataHash: sha256(Buffer.from(canonical, "utf8")).toString("hex"),
    canonical,
  };
}

export function verifyProof(root: string, epoch: bigint, accountId: string, amount: bigint, proof: string[]): boolean {
  let h = leafHash(epoch, accountId, amount);
  for (const p of proof) h = nodeHash(h, Buffer.from(p, "hex"));
  return h.toString("hex") === root;
}

export const sha256Hex = (s: string) => sha256(Buffer.from(s, "utf8")).toString("hex");
