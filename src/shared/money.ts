/**
 * Fixed-point integer money. Every asset amount in BAGFLIP is a bigint in the
 * asset's smallest unit (yoctoNEAR, lamports, token base units). Floating
 * point is only ever used for *display* and for *strategy signals* (prices,
 * percentages), never for balances, entitlements or ledger entries.
 */

export const NEAR_DECIMALS = 24;
export const SOL_DECIMALS = 9;
export const USD_MICRO_DECIMALS = 6;

export type Asset = "NEAR" | "SOL";
export const ASSET_DECIMALS: Record<Asset, number> = { NEAR: NEAR_DECIMALS, SOL: SOL_DECIMALS };

/** "1.5" with 24 decimals -> 1500000000000000000000000n. Rejects garbage, rounds nothing. */
export function parseUnits(value: string | number, decimals: number): bigint {
  const s = typeof value === "number" ? numberToPlain(value) : value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(s)) throw new Error(`Invalid decimal amount: ${JSON.stringify(value)}`);
  const neg = s.startsWith("-");
  const [whole, frac = ""] = (neg ? s.slice(1) : s).split(".");
  if (frac.length > decimals) {
    // Truncate extra precision toward zero (never invent value).
    const out = BigInt(whole! + frac.slice(0, decimals));
    return neg ? -out : out;
  }
  const out = BigInt(whole! + frac.padEnd(decimals, "0"));
  return neg ? -out : out;
}

function numberToPlain(n: number): string {
  if (!Number.isFinite(n)) throw new Error(`Invalid number ${n}`);
  // toFixed avoids exponent notation for the magnitudes we use in config.
  return n.toFixed(12).replace(/\.?0+$/, "");
}

/** 1500000000000000000000000n, 24 -> "1.5" */
export function formatUnits(value: bigint, decimals: number, maxFrac = decimals): string {
  const neg = value < 0n;
  const v = neg ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  let frac = (v % base).toString().padStart(decimals, "0").slice(0, maxFrac).replace(/0+$/, "");
  const out = frac ? `${whole}.${frac}` : `${whole}`;
  return neg ? `-${out}` : out;
}

export function formatAsset(value: bigint, asset: Asset, maxFrac = 4): string {
  return `${formatUnits(value, ASSET_DECIMALS[asset], maxFrac)} ${asset}`;
}

/** value * num / den, rounded toward zero. */
export function mulDiv(value: bigint, num: bigint, den: bigint): bigint {
  if (den === 0n) throw new Error("mulDiv by zero");
  return (value * num) / den;
}

/** Basis-point share of a value (10000 bps = 100%), rounded down. */
export function bps(value: bigint, basisPoints: number | bigint): bigint {
  return mulDiv(value, BigInt(basisPoints), 10_000n);
}

export function percentToBps(p: number): bigint {
  return BigInt(Math.round(p * 100));
}

export const min = (a: bigint, b: bigint) => (a < b ? a : b);
export const max = (a: bigint, b: bigint) => (a > b ? a : b);

/** Convert an asset amount to micro-USD using a USD price (display + thresholds only). */
export function toUsdMicro(amount: bigint, asset: Asset, priceUsd: number): bigint {
  // price as 1e9 fixed-point to keep integer math.
  const p = BigInt(Math.round(priceUsd * 1e9));
  return (amount * p * 10n ** BigInt(USD_MICRO_DECIMALS)) / (10n ** BigInt(ASSET_DECIMALS[asset]) * 1_000_000_000n);
}

/** Convert micro-USD to an asset amount (rounded down). */
export function fromUsdMicro(usdMicro: bigint, asset: Asset, priceUsd: number): bigint {
  const p = BigInt(Math.round(priceUsd * 1e9));
  if (p <= 0n) throw new Error(`No usable ${asset} price`);
  return (usdMicro * 10n ** BigInt(ASSET_DECIMALS[asset]) * 1_000_000_000n) / (p * 10n ** BigInt(USD_MICRO_DECIMALS));
}

export function formatUsd(usdMicro: bigint): string {
  const neg = usdMicro < 0n;
  const v = neg ? -usdMicro : usdMicro;
  const cents = (v + 5_000n) / 10_000n;
  const s = `$${(cents / 100n).toLocaleString("en-US")}.${(cents % 100n).toString().padStart(2, "0")}`;
  return neg ? `-${s}` : s;
}

/** Ratio of two bigints as a float (display/signal use only). */
export function ratio(a: bigint, b: bigint): number {
  if (b === 0n) return 0;
  // scale to keep precision for huge values
  const SCALE = 1_000_000_000n;
  return Number((a * SCALE) / b) / Number(SCALE);
}
