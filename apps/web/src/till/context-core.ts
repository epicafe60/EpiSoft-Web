import { createContext } from 'react';
import type { TillSettings } from '@episoft/shared';
import type { MetaValues } from './db';
import type { SyncEngine, SyncState } from './sync';

export interface TillContextValue {
  engine: SyncEngine;
  sync: SyncState;
  meta: MetaValues;
  settings: TillSettings | null;
  pendingCount: number;
  rejectedCount: number;
  cashierId: string;
  /** R-OFF-04: server balance at the last refresh, minus the local moves not yet in it. */
  balanceCents: (householdId: string) => number | null;
}

/**
 * Kept in its own module on purpose: the provider and the screens must share one context object,
 * and with Vite hot reloading a module that is edited can be loaded twice.
 */
export const TillContext = createContext<TillContextValue | null>(null);
