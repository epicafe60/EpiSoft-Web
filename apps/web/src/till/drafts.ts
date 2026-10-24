import { getMeta, setMeta, tillDb, type Draft } from './db';

// Tickets being entered are stored in IndexedDB at each change, so a reload or a crash
// loses nothing (R-VTE-08, R-OFF-06).

export async function activeDraft(): Promise<Draft> {
  const id = await getMeta('activeDraftId');
  const existing = id ? await tillDb.drafts.get(id) : undefined;
  if (existing && !existing.parked) return existing;
  return newDraft();
}

export async function newDraft(): Promise<Draft> {
  const now = new Date().toISOString();
  const d: Draft = {
    id: crypto.randomUUID(),
    memberId: null,
    lines: [],
    parked: false,
    createdAt: now,
    updatedAt: now,
  };
  await tillDb.transaction('rw', [tillDb.drafts, tillDb.meta], async () => {
    await tillDb.drafts.put(d);
    await setMeta('activeDraftId', d.id);
  });
  return d;
}

/** A new ticket pre-filled with the lines (and member) of a refused one. */
export async function draftFromSale(
  lines: Draft['lines'],
  memberId: string | null,
): Promise<Draft> {
  const d = await newDraft();
  await updateDraft(d.id, () => ({ lines, memberId }));
  return { ...d, lines, memberId };
}

export async function updateDraft(id: string, change: (d: Draft) => Partial<Draft>): Promise<void> {
  await tillDb.transaction('rw', tillDb.drafts, async () => {
    const d = await tillDb.drafts.get(id);
    if (!d) return;
    await tillDb.drafts.put({ ...d, ...change(d), updatedAt: new Date().toISOString() });
  });
}

/** R-VTE-08: puts the current ticket on hold and starts a new one. */
export async function parkDraft(id: string): Promise<void> {
  await updateDraft(id, () => ({ parked: true }));
  await newDraft();
}

export async function resumeDraft(id: string): Promise<void> {
  await tillDb.transaction('rw', [tillDb.drafts, tillDb.meta], async () => {
    const current = await getMeta('activeDraftId');
    const cur = current ? await tillDb.drafts.get(current) : undefined;
    // An empty current ticket is discarded; a non-empty one is put on hold.
    if (cur && cur.id !== id) {
      if (cur.lines.length || cur.memberId) await tillDb.drafts.put({ ...cur, parked: true });
      else await tillDb.drafts.delete(cur.id);
    }
    const d = await tillDb.drafts.get(id);
    if (d) await tillDb.drafts.put({ ...d, parked: false });
    await setMeta('activeDraftId', id);
  });
}
