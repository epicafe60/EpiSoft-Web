import { useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useQuery } from '@tanstack/react-query';
import { estimatedBalanceCents, decimalToCents } from '@episoft/shared';
import { api } from '@/lib/api';
import { useMe } from '@/lib/auth';
import { getMeta, tillDb, type MetaValues } from './db';
import { pendingWalletMoves } from './logic';
import { SyncEngine, type SyncState } from './sync';
import { TillContext, type TillContextValue } from './context-core';

const META_KEYS: (keyof MetaValues)[] = [
  'device',
  'session',
  'deviceSeq',
  'cursor',
  'lastSnapshotAt',
  'lastPushAt',
  'settings',
  'cashierId',
  'activeDraftId',
];

export function TillProvider({ children }: { children: ReactNode }) {
  const me = useMe();
  const engine = useMemo(() => new SyncEngine(), []);
  const [sync, setSync] = useState<SyncState>({
    online: navigator.onLine,
    pushing: false,
    authRequired: false,
    lastError: null,
  });

  useEffect(() => {
    const off = engine.subscribe(setSync);
    engine.start();
    return () => {
      off();
      engine.stop();
    };
  }, [engine]);

  const meta = useLiveQuery(async () => {
    const entries = await Promise.all(META_KEYS.map(async (k) => [k, await getMeta(k)] as const));
    return Object.fromEntries(entries) as unknown as MetaValues;
  });
  const outbox = useLiveQuery(() => tillDb.outbox.toArray(), []);
  const members = useLiveQuery(() => tillDb.members.toArray(), []);
  const households = useLiveQuery(() => tillDb.households.toArray(), []);

  if (!meta || !outbox || !members || !households) {
    return <p className="p-6 text-muted-foreground">Chargement de la caisse…</p>;
  }

  const householdOfMember = (id: string) => members.find((m) => m.id === id)?.householdId ?? null;
  const moves = pendingWalletMoves(outbox, meta.lastSnapshotAt, householdOfMember);
  const value: TillContextValue = {
    engine,
    sync,
    meta,
    settings: meta.settings,
    pendingCount: outbox.filter((o) => o.status === 'PENDING').length,
    rejectedCount: outbox.filter((o) => o.status === 'REJECTED' && !o.acknowledged).length,
    cashierId: meta.cashierId ?? me.id,
    balanceCents: (householdId) => {
      const h = households.find((x) => x.id === householdId);
      return h ? estimatedBalanceCents(householdId, decimalToCents(h.balance), moves) : null;
    },
  };
  return <TillContext.Provider value={value}>{children}</TillContext.Provider>;
}

export function useTill(): TillContextValue {
  const v = useContext(TillContext);
  if (!v) throw new Error('useTill() hors de la caisse');
  return v;
}

/** The device state as seen by the server (open session, proposed float), when online. */
export function useDeviceState(deviceId: string | null) {
  return useQuery({
    queryKey: ['device-state', deviceId],
    queryFn: () =>
      api.get<{
        device: { id: string; name: string; active: boolean };
        openSession: { id: string; openedAt: string; openingFloat: string } | null;
        proposedFloat: string;
      }>(`/pos/devices/${deviceId}/state`),
    enabled: !!deviceId,
    retry: false,
    staleTime: 0,
  });
}
