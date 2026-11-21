/**
 * R-STK-06: stock valued at the weighted average unit cost (CMUP, « coût moyen unitaire pondéré »),
 * the method of the PCG (art. 213-32) for fungible goods. The average is kept running: every
 * entry at a cost recomputes it, exits and losses leave it unchanged and are valued at it.
 * Costs are excl. VAT, with 6 decimals so that the rounding of the average stays far below a cent.
 */

export const AVG_COST_SCALE = 1_000_000;

export interface AverageState {
  /** Stock in thousandths before the movement (may be negative: sold before received). */
  qtyMilli: number;
  /** Average unit cost excl. VAT, in millionths of euro; null when never known. */
  avgMicro: number | null;
}

export interface CostMovement {
  qtyMilli: number;
  /** Unit cost of the goods entering (millionths of euro); only used by an entry. */
  unitCostMicro: number | null;
  /** True for a purchase or an opening stock: its cost enters the average. */
  priced: boolean;
}

/**
 * The average after a movement. An entry at a cost (reception, opening stock):
 * (stock × average + entered × cost) / new stock; when the stock was empty or negative the cost
 * becomes the average. Any other movement leaves the average alone, except that an entry with no
 * average yet takes the cost given, when there is one.
 */
export function nextAverage(s: AverageState, m: CostMovement): number | null {
  if (m.qtyMilli > 0 && m.unitCostMicro !== null) {
    if (m.priced || s.avgMicro === null) {
      if (s.qtyMilli <= 0 || s.avgMicro === null) return m.unitCostMicro;
      const total = s.qtyMilli + m.qtyMilli;
      return Math.round((s.qtyMilli * s.avgMicro + m.qtyMilli * m.unitCostMicro) / total);
    }
  }
  return s.avgMicro;
}

/** Value in cents of a quantity (thousandths) at an average cost (millionths of euro). */
export function valueAtAverageCents(qtyMilli: number, avgMicro: number | null): number {
  if (avgMicro === null) return 0;
  return Math.round((qtyMilli * avgMicro) / 1e7);
}

export const microToDecimal = (micro: number): string => (micro / AVG_COST_SCALE).toFixed(6);
export const decimalToMicro = (v: string | null | undefined): number | null =>
  v === null || v === undefined || v === '' ? null : Math.round(Number(v) * AVG_COST_SCALE);

/** Kinds whose cost enters the average. The others are valued at the current average. */
export const PRICED_MOVEMENT_KINDS = ['PURCHASE_IN', 'INITIAL'] as const;
