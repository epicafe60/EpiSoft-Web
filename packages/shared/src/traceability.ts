// Traceability of the lots (règlement CE 178/2002, art. 18: « un cran en amont, un cran en aval »).
//
// The till does not scan lot numbers: a sale takes quantities of a product, not of a lot. What a
// lot was sold in is therefore an ESTIMATE, made like the shelf is served: first expired, first out
// (FEFO). Goods leaving the stock (sales, losses, returns) are replayed in order of time; each one
// takes from the lots already received, the earliest best-before date first (a lot without a date
// last, then the oldest reception). The estimate is exact when the shelf is really served that way,
// and it is a good bracket otherwise: it must be read as « could have been sold from this lot ».

export interface FefoLot {
  id: string;
  /** Day of the reception (YYYY-MM-DD, shop calendar): the lot is available from that day. */
  receivedOn: string;
  /** DLC / DDM (YYYY-MM-DD) or null. */
  bestBefore: string | null;
  /** Quantity received, in thousandths. */
  qtyMilli: number;
}

export interface FefoOut {
  id: string;
  /** Day of the exit (YYYY-MM-DD, shop calendar). */
  day: string;
  /** Exact instant, to order the exits of a same day. */
  at: string;
  /** Quantity leaving, in thousandths, positive. */
  qtyMilli: number;
}

export interface FefoAllocation {
  outId: string;
  lotId: string;
  qtyMilli: number;
}

export interface FefoResult {
  allocations: FefoAllocation[];
  /** Exits (or parts of exits) for which no lot was available: stock older than the records. */
  unallocated: { outId: string; qtyMilli: number }[];
  /** What is left of each lot after every exit. */
  remaining: Map<string, number>;
}

const lotOrder = (a: FefoLot, b: FefoLot) => {
  if (a.bestBefore !== b.bestBefore) {
    if (a.bestBefore === null) return 1;
    if (b.bestBefore === null) return -1;
    return a.bestBefore < b.bestBefore ? -1 : 1;
  }
  if (a.receivedOn !== b.receivedOn) return a.receivedOn < b.receivedOn ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

export function allocateFefo(lots: readonly FefoLot[], outs: readonly FefoOut[]): FefoResult {
  const sortedLots = [...lots].sort(lotOrder);
  const remaining = new Map(lots.map((l) => [l.id, l.qtyMilli]));
  const allocations: FefoAllocation[] = [];
  const unallocated: { outId: string; qtyMilli: number }[] = [];
  const ordered = [...outs].sort((a, b) =>
    a.at === b.at ? (a.id < b.id ? -1 : 1) : a.at < b.at ? -1 : 1,
  );
  for (const out of ordered) {
    let need = out.qtyMilli;
    for (const lot of sortedLots) {
      if (need <= 0) break;
      if (lot.receivedOn > out.day) continue;
      const left = remaining.get(lot.id)!;
      if (left <= 0) continue;
      const take = Math.min(left, need);
      remaining.set(lot.id, left - take);
      allocations.push({ outId: out.id, lotId: lot.id, qtyMilli: take });
      need -= take;
    }
    if (need > 0) unallocated.push({ outId: out.id, qtyMilli: need });
  }
  return { allocations, unallocated, remaining };
}

/** What a lot number must look like: something printed on the pack, not an empty or silly value. */
export function lotNumberProblem(raw: string | null | undefined): string | null {
  const s = (raw ?? '').trim();
  if (s.length < 2) return 'Numéro de lot obligatoire (celui imprimé sur l’emballage).';
  if (s.length > 60) return 'Numéro de lot trop long (60 caractères au plus).';
  if (/^(0+|-+|n\/?a|néant|neant|aucun|inconnu|\?+|x+)$/i.test(s))
    return 'Numéro de lot invalide : recopiez celui imprimé sur l’emballage.';
  return null;
}

export interface LotRequirement {
  lotNumber: string | null;
  bestBefore: string | null;
}

/**
 * A food product received must come with its supplier lot number and its best-before date.
 * Fresh fruit and vegetables carry no date marking (règlement UE 1169/2011, annexe X): the lot
 * number is enough for them.
 */
export function receiptLotProblem(
  product: { name: string; isFood: boolean; kind: string; originFamily: string | null },
  lot: LotRequirement,
): string | null {
  if (!product.isFood || product.kind !== 'GOODS') return null;
  const bad = lotNumberProblem(lot.lotNumber);
  if (bad) return `${product.name} : ${bad[0]!.toLowerCase()}${bad.slice(1)}`;
  if (!lot.bestBefore && product.originFamily !== 'FRUIT_VEG')
    return `${product.name} : date limite (DLC) ou date de durabilité minimale (DDM) obligatoire pour un produit alimentaire.`;
  return null;
}
