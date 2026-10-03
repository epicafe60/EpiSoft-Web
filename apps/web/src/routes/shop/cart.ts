import { useSyncExternalStore } from 'react';
import { milliToDecimal, parseQtyToMilli } from '@episoft/shared';

// The customer's cart (R-PRE-01). Kept in the browser so a reload or a closed tab keeps it;
// the order only exists on the server once it is submitted.

export interface CartLine {
  productId: string;
  name: string;
  /** Catalogue price in cents, shown for information. */
  unitPriceCents: number;
  /** Decimal string, 3 decimals. */
  qty: string;
  unit: string | null;
}

const KEY = 'episoft.cart';
let lines: CartLine[] = read();
const listeners = new Set<() => void>();

function read(): CartLine[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(parsed) ? (parsed as CartLine[]) : [];
  } catch {
    return [];
  }
}

function commit(next: CartLine[]) {
  lines = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Private mode: the cart lives for the page only.
  }
  listeners.forEach((l) => l());
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function useCart() {
  const current = useSyncExternalStore(subscribe, () => lines);
  return {
    lines: current,
    count: current.length,
    add(line: Omit<CartLine, 'qty'>, qty: string) {
      const add = parseQtyToMilli(qty) ?? 0;
      if (add <= 0) return;
      const found = lines.find((l) => l.productId === line.productId);
      commit(
        found
          ? lines.map((l) =>
              l === found ? { ...l, qty: milliToDecimal((parseQtyToMilli(l.qty) ?? 0) + add) } : l,
            )
          : [...lines, { ...line, qty: milliToDecimal(add) }],
      );
    },
    setQty(productId: string, qty: string) {
      const milli = parseQtyToMilli(qty);
      if (milli === null) return;
      commit(
        milli <= 0
          ? lines.filter((l) => l.productId !== productId)
          : lines.map((l) =>
              l.productId === productId ? { ...l, qty: milliToDecimal(milli) } : l,
            ),
      );
    },
    remove: (productId: string) => commit(lines.filter((l) => l.productId !== productId)),
    clear: () => commit([]),
  };
}
