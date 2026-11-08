import { createContext } from 'react';
import type { CashierCheck, TillSettings } from '@episoft/shared';
import type { MetaValues } from './db';
import type { SyncEngine, SyncState } from './sync';

export interface TillContextValue {
  engine: SyncEngine;
  sync: SyncState;
  meta: MetaValues;
  settings: TillSettings | null;
  pendingCount: number;
  rejectedCount: number;
  /** R-SES-07: the cashier keeping the till (the person signed in unless another was chosen). */
  cashierId: string;
  /** How that cashier was established, sent with each operation. */
  cashierCheck: CashierCheck;
  /** The person signed in: the session and its rights. */
  sessionUserId: string;
  /** A ticket was made: the cashier is still there (R-SES-07, asked again after a while). */
  noteCashierActivity: () => Promise<void>;
  /** R-OFF-04: server balance at the last refresh, minus the local moves not yet in it. */
  balanceCents: (householdId: string) => number | null;
}

/**
 * Kept in its own module on purpose: the provider and the screens must share one context object,
 * and with Vite hot reloading a module that is edited can be loaded twice.
 */
export const TillContext = createContext<TillContextValue | null>(null);
