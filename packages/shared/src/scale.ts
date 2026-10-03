import { isValidEan } from './pos';

// R-VTE-04 [nouveau]: in-store barcodes printed by a scale (GS1 prefixes 20–29).
// Layout used by the common French scales: PP CCCCC VVVVV K
//   PP    prefix 20–29
//   CCCCC article code (PLU) programmed in the scale
//   VVVVV value: price in cents, or weight in grams
//   K     EAN-13 check digit
// The format of the shop's scale is still to be confirmed; it is a setting.

export type ScaleValueKind = 'PRICE' | 'WEIGHT';

export interface ScaleBarcode {
  plu: string;
  kind: ScaleValueKind;
  /** Cents for PRICE, grams for WEIGHT. */
  value: number;
}

export function decodeScaleBarcode(code: string, kind: ScaleValueKind): ScaleBarcode | null {
  if (!/^2\d{12}$/.test(code) || !isValidEan(code)) return null;
  return { plu: code.slice(2, 7), kind, value: Number(code.slice(7, 12)) };
}

/**
 * The PLU is matched against the product code: exact, or the code ending with the PLU
 * (scales store 5 digits, product codes have 6). Only an unambiguous match is accepted.
 */
export function productForPlu<P extends { code: string }>(
  products: readonly P[],
  plu: string,
): P | null {
  const exact = products.filter((p) => p.code === plu);
  if (exact.length === 1) return exact[0]!;
  const trimmed = plu.replace(/^0+/, '');
  const suffix = products.filter((p) => p.code.endsWith(plu) || (trimmed && p.code === trimmed));
  return suffix.length === 1 ? suffix[0]! : null;
}

/**
 * Quantity in thousandths of the sale unit for a scale label.
 * WEIGHT: the grams converted to the product unit (kg → /1000, g → as is).
 * PRICE: the quantity whose rounded amount equals the printed price, when one exists
 * (searched around price ÷ unit price), otherwise the nearest.
 */
export function scaleQuantityMilli(
  label: ScaleBarcode,
  unitPriceCents: number,
  unit: 'G' | 'KG' | 'ML' | 'L' | null,
): number | null {
  if (label.kind === 'WEIGHT') {
    if (unit === 'G' || unit === 'ML') return label.value * 1000;
    return label.value; // grams = thousandths of a kg
  }
  if (unitPriceCents <= 0) return null;
  const guess = Math.round((label.value * 1000) / unitPriceCents);
  const amount = (q: number) => Math.round((q * unitPriceCents) / 1000);
  for (let d = 0; d <= 5; d++) {
    for (const q of [guess - d, guess + d]) if (q > 0 && amount(q) === label.value) return q;
  }
  return guess > 0 ? guess : null;
}
