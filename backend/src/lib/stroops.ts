/**
 * Fixed-point conversion utilities between Stellar stroops (1 XLM = 10^7 stroops)
 * and display XLM values.
 *
 * Avoids IEEE-754 floating-point multiplication/division (`amount * 1e7` or
 * `Number(stroops) / 1e7`) which introduces rounding drift on values such as
 * `0.29` XLM (`0.29 * 10_000_000 === 2899999.9999999995`, where `Math.floor`
 * silently drops 1 stroop) or `i128` stroop values exceeding `Number.MAX_SAFE_INTEGER`.
 */

export const STROOPS_DECIMALS = 7;
export const STROOPS_PER_XLM = 10_000_000n;

/**
 * Parses a raw stroop representation (`bigint`, integer string, or integer number)
 * into an exact `bigint` without floating-point scaling.
 */
export function parseStroops(raw: bigint | string | number): bigint {
  if (typeof raw === "bigint") {
    return raw;
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!/^[+-]?\d+$/.test(trimmed)) {
      throw new RangeError(`Invalid integer stroops string: "${raw}"`);
    }
    return BigInt(trimmed);
  }
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) {
      throw new RangeError(`Invalid stroops number: ${raw}`);
    }
    return BigInt(Math.trunc(raw));
  }
  throw new TypeError(`Unsupported stroops type: ${typeof raw}`);
}

/**
 * Converts a display XLM value (`number`, decimal `string`, or integer `bigint` XLM)
 * into exact integer stroops using fixed-point string decomposition instead of
 * floating-point multiplication.
 */
export function xlmToStroops(xlm: number | string | bigint): bigint {
  if (typeof xlm === "bigint") {
    return xlm * STROOPS_PER_XLM;
  }

  let decimalStr: string;
  if (typeof xlm === "number") {
    if (!Number.isFinite(xlm)) {
      throw new RangeError(`Invalid XLM amount: ${xlm}`);
    }
    // Stellar assets have 7 decimal places; formatting with toFixed(7) recovers
    // the exact 7-decimal representation of IEEE-754 numbers (e.g. 0.29 -> "0.2900000")
    // without multiplying by 10_000_000 in binary floating point.
    decimalStr = xlm.toFixed(STROOPS_DECIMALS);
  } else if (typeof xlm === "string") {
    decimalStr = xlm.trim();
  } else {
    throw new TypeError(`Unsupported XLM amount type: ${typeof xlm}`);
  }

  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(decimalStr);
  if (!match) {
    throw new RangeError(`Invalid XLM decimal value: "${xlm}"`);
  }

  const sign = match[1] === "-" ? -1n : 1n;
  const wholePart = BigInt(match[2]);
  const rawFrac = match[3] ?? "";

  const paddedFrac = rawFrac.slice(0, STROOPS_DECIMALS).padEnd(STROOPS_DECIMALS, "0");
  let fracStroops = BigInt(paddedFrac);

  if (rawFrac.length > STROOPS_DECIMALS) {
    const nextDigit = Number(rawFrac[STROOPS_DECIMALS]);
    if (nextDigit >= 5) {
      fracStroops += 1n;
    }
  }

  return sign * (wholePart * STROOPS_PER_XLM + fracStroops);
}

/**
 * Formats an exact stroop amount as a canonical decimal XLM string using pure
 * `BigInt` division and modulo (zero floating-point arithmetic).
 */
export function stroopsToXlmString(stroops: bigint | string | number): string {
  const total = parseStroops(stroops);
  const isNegative = total < 0n;
  const abs = isNegative ? -total : total;

  const whole = abs / STROOPS_PER_XLM;
  const frac = abs % STROOPS_PER_XLM;

  const prefix = isNegative ? "-" : "";
  if (frac === 0n) {
    return `${prefix}${whole.toString()}`;
  }

  const fracStr = frac.toString().padStart(STROOPS_DECIMALS, "0").replace(/0+$/, "");
  return `${prefix}${whole.toString()}.${fracStr}`;
}

/**
 * Converts an integer stroop amount to a display XLM `number` at the API boundary
 * by parsing the exact fixed-point decimal string representation rather than
 * dividing two `Number` values.
 */
export function stroopsToXlmNumber(stroops: bigint | string | number): number {
  return Number(stroopsToXlmString(stroops));
}

/**
 * Resolves exact stroops from an optional stored `stroops` string/bigint when
 * available, falling back to fixed-point conversion from the XLM amount.
 */
export function resolveStroops(
  xlmAmount: number | string,
  exactStroops?: bigint | string | null
): bigint {
  if (exactStroops !== undefined && exactStroops !== null && exactStroops !== "") {
    return parseStroops(exactStroops);
  }
  return xlmToStroops(xlmAmount);
}
