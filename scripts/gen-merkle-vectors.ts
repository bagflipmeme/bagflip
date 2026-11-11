/** Regenerate contracts/vault/test-vectors/merkle.json (consumed by Rust and TS tests). */
import { writeFileSync } from "node:fs";
import { buildPayoutTree, leafHash } from "../src/distribution/merkle.ts";

const cases = [
  { epoch: 1n, leaves: [{ accountId: "alice.near", amount: 6_000_000_000_000_000_000_000_000n }] },
  {
    epoch: 7n,
    leaves: [
      { accountId: "alice.near", amount: 6_000_000_000_000_000_000_000_000n },
      { accountId: "bob.near", amount: 3_000_000_000_000_000_000_000_000n },
      { accountId: "carol.near", amount: 1_000_000_000_000_000_000_000_000n },
    ],
  },
  {
    epoch: 42n,
    leaves: Array.from({ length: 11 }, (_, i) => ({ accountId: `holder${i}.near`, amount: BigInt(i + 1) * 123_456_789n + (1n << 70n) })),
  },
];
const out = cases.map((c) => {
  const t = buildPayoutTree(c.epoch, c.leaves);
  return {
    epoch: Number(c.epoch),
    root: t.root,
    total: t.total.toString(),
    data_hash: t.dataHash,
    leaves: t.leaves.map((l) => ({ account_id: l.accountId, amount: l.amount.toString(), leaf: leafHash(c.epoch, l.accountId, l.amount).toString("hex"), proof: t.proofs.get(l.accountId) })),
  };
});
writeFileSync("contracts/vault/test-vectors/merkle.json", JSON.stringify(out, null, 2) + "\n");
console.log(`wrote ${out.length} cases`);
