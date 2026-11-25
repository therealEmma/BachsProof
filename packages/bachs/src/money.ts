/**
 * Exact decimal parsing for Bachs amounts.
 *
 * Bachs sends money as decimal strings at the currency's precision. We keep
 * the decimal coefficient as a bigint and retain its scale rather than ever
 * passing through Number arithmetic. Callers can convert to a bounded integer
 * only at an application boundary that explicitly requires it.
 */
export interface ExactMoney {
  currency: string;
  coefficient: bigint;
  scale: number;
}

const DECIMAL_AMOUNT = /^(?:0|[1-9]\d*)(?:\.(\d+))?$/;

function normalize(coefficient: bigint, scale: number): { coefficient: bigint; scale: number } {
  let normalizedCoefficient = coefficient;
  let normalizedScale = scale;
  while (normalizedScale > 0 && normalizedCoefficient % 10n === 0n) {
    normalizedCoefficient /= 10n;
    normalizedScale -= 1;
  }
  return { coefficient: normalizedCoefficient, scale: normalizedScale };
}

/** Parse a Bachs decimal amount without floating-point conversion. */
export function parseBachsMoney(amount: string, currency: string): ExactMoney {
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error(`Invalid ISO currency ${currency}`);
  const match = DECIMAL_AMOUNT.exec(amount);
  if (!match) throw new Error(`Invalid Bachs decimal amount ${amount}`);
  const fraction = match[1] ?? "";
  const coefficient = BigInt(`${match[0].split(".")[0]}${fraction}`);
  return { coefficient, scale: fraction.length, currency };
}

/** Compare two exact monetary values after checking their currencies. */
export function compareBachsMoney(left: ExactMoney, right: ExactMoney): -1 | 0 | 1 {
  if (left.currency !== right.currency) throw new Error("Cannot compare money in different currencies");
  const normalizedLeft = normalize(left.coefficient, left.scale);
  const normalizedRight = normalize(right.coefficient, right.scale);
  const scale = Math.max(normalizedLeft.scale, normalizedRight.scale);
  const leftValue = normalizedLeft.coefficient * 10n ** BigInt(scale - normalizedLeft.scale);
  const rightValue = normalizedRight.coefficient * 10n ** BigInt(scale - normalizedRight.scale);
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

/** Convert an exact amount to an integer at the supplied storage scale. */
export function toBachsMinorUnits(value: ExactMoney, scale: number): bigint {
  if (!Number.isInteger(scale) || scale < 0) throw new Error("Money scale must be a non-negative integer");
  if (value.scale > scale && value.coefficient % (10n ** BigInt(value.scale - scale)) !== 0n) {
    throw new Error(`Amount ${value.coefficient} has more precision than storage scale ${scale}`);
  }
  return value.coefficient * 10n ** BigInt(scale - value.scale);
}

/** Convert a bigint to the provider-neutral number shape only when safe. */
export function safeNumberMoney(value: bigint): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error("Financial amount exceeds JavaScript safe integer range");
  return number;
}

/** Format an integer amount for a local fixture without floating-point math. */
export function formatBachsMoney(value: bigint, scale: number): string {
  if (scale < 0 || !Number.isInteger(scale)) throw new Error("Money scale must be a non-negative integer");
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(scale + 1, "0");
  if (scale === 0) return `${negative ? "-" : ""}${digits}`;
  const split = digits.length - scale;
  return `${negative ? "-" : ""}${digits.slice(0, split)}.${digits.slice(split)}`;
}
