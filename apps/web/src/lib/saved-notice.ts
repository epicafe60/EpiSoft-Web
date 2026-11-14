import { useState } from 'react';

/**
 * « Fiche enregistrée. » must outlive the form: after a save the sheet is reloaded and its form is
 * created again (its key is the `updatedAt`), which would wipe a message held by the form itself.
 * The page that owns the form holds the flag.
 */
export function useSavedNotice() {
  const [saved, setSaved] = useState(false);
  return { saved, mark: () => setSaved(true), clear: () => setSaved(false) };
}
export type SavedNotice = ReturnType<typeof useSavedNotice>;
