// FEC self-check (art. A47 A-1 du Livre des procédures fiscales): what the tax auditor's test
// tool would reject, found before the file is handed over.

export interface FecCheckEntry {
  id: string;
  journalCode: string;
  /** Null while a draft. */
  number: number | null;
  date: string;
  status: 'DRAFT' | 'VALIDATED';
  pieceRef: string | null;
  label: string;
  validatedOn: string | null;
  lines: { label: string; debitCents: number; creditCents: number }[];
}

export type FecAnomalyCode =
  | 'DRAFT'
  | 'UNBALANCED_ENTRY'
  | 'TOTAL_UNBALANCED'
  | 'NUMBER_GAP'
  | 'NUMBER_DUPLICATE'
  | 'NOT_CHRONOLOGICAL'
  | 'DATE_OUT_OF_YEAR'
  | 'VALIDATION_BEFORE_DATE'
  | 'MISSING_LABEL'
  | 'MISSING_PIECE'
  | 'LINE_BOTH_SIDES'
  | 'NO_SIREN';

export interface FecAnomaly {
  code: FecAnomalyCode;
  /** An error blocks the export; a warning is only reported. */
  severity: 'error' | 'warning';
  message: string;
  journalCode?: string;
  entryId?: string;
}

const fr = (d: string) => d.split('-').reverse().join('/');

export function checkFec(a: {
  entries: readonly FecCheckEntry[];
  startDate: string;
  endDate: string;
  siren: string | null;
}): FecAnomaly[] {
  const out: FecAnomaly[] = [];
  const add = (x: FecAnomaly) => out.push(x);
  if (!a.siren || !/^\d{9}$/.test(a.siren.replace(/\s/g, '')))
    add({
      code: 'NO_SIREN',
      severity: 'warning',
      message:
        'Le SIREN n’est pas renseigné (Paramètres › Association) : le fichier doit être nommé SIRENFECAAAAMMJJ.txt.',
    });

  let debit = 0;
  let credit = 0;
  const byJournal = new Map<string, FecCheckEntry[]>();
  for (const e of a.entries) {
    if (e.status !== 'VALIDATED' || e.number === null) {
      add({
        code: 'DRAFT',
        severity: 'error',
        message: `Écriture « ${e.label} » du ${fr(e.date)} non validée : elle n’a pas de numéro.`,
        journalCode: e.journalCode,
        entryId: e.id,
      });
      continue;
    }
    const d = e.lines.reduce((s, l) => s + l.debitCents, 0);
    const c = e.lines.reduce((s, l) => s + l.creditCents, 0);
    debit += d;
    credit += c;
    if (d !== c || e.lines.length < 2)
      add({
        code: 'UNBALANCED_ENTRY',
        severity: 'error',
        message: `Écriture ${e.journalCode} n° ${e.number} (${fr(e.date)}) déséquilibrée : débit ${(d / 100).toFixed(2)}, crédit ${(c / 100).toFixed(2)}.`,
        journalCode: e.journalCode,
        entryId: e.id,
      });
    if (e.date < a.startDate || e.date > a.endDate)
      add({
        code: 'DATE_OUT_OF_YEAR',
        severity: 'error',
        message: `Écriture ${e.journalCode} n° ${e.number} datée du ${fr(e.date)}, hors de l’exercice (${fr(a.startDate)} au ${fr(a.endDate)}).`,
        journalCode: e.journalCode,
        entryId: e.id,
      });
    if (e.validatedOn && e.validatedOn < e.date)
      add({
        code: 'VALIDATION_BEFORE_DATE',
        severity: 'warning',
        message: `Écriture ${e.journalCode} n° ${e.number} validée (${fr(e.validatedOn)}) avant sa date (${fr(e.date)}).`,
        journalCode: e.journalCode,
        entryId: e.id,
      });
    if (!e.label.trim() || e.lines.some((l) => !l.label.trim()))
      add({
        code: 'MISSING_LABEL',
        severity: 'error',
        message: `Écriture ${e.journalCode} n° ${e.number} : libellé manquant.`,
        journalCode: e.journalCode,
        entryId: e.id,
      });
    if (!e.pieceRef?.trim())
      add({
        code: 'MISSING_PIECE',
        severity: 'warning',
        message: `Écriture ${e.journalCode} n° ${e.number} sans référence de pièce : le numéro d’écriture est repris.`,
        journalCode: e.journalCode,
        entryId: e.id,
      });
    if (e.lines.some((l) => l.debitCents > 0 && l.creditCents > 0))
      add({
        code: 'LINE_BOTH_SIDES',
        severity: 'error',
        message: `Écriture ${e.journalCode} n° ${e.number} : une ligne est à la fois au débit et au crédit.`,
        journalCode: e.journalCode,
        entryId: e.id,
      });
    byJournal.set(e.journalCode, [...(byJournal.get(e.journalCode) ?? []), e]);
  }
  if (debit !== credit)
    add({
      code: 'TOTAL_UNBALANCED',
      severity: 'error',
      message: `Le total des débits (${(debit / 100).toFixed(2)}) diffère du total des crédits (${(credit / 100).toFixed(2)}).`,
    });

  for (const [journalCode, list] of byJournal) {
    const sorted = [...list].sort((x, y) => x.number! - y.number!);
    let expected = 1;
    let lastDate = '';
    let inversion = false;
    for (const e of sorted) {
      if (e.number! < expected)
        add({
          code: 'NUMBER_DUPLICATE',
          severity: 'error',
          message: `Journal ${journalCode} : le numéro ${e.number} est utilisé plusieurs fois.`,
          journalCode,
          entryId: e.id,
        });
      else if (e.number! > expected) {
        add({
          code: 'NUMBER_GAP',
          severity: 'error',
          message: `Journal ${journalCode} : la numérotation saute de ${expected} à ${e.number}${e.number! - expected > 1 ? ` (${e.number! - expected} numéros manquants)` : ''}.`,
          journalCode,
          entryId: e.id,
        });
        expected = e.number!;
      }
      expected = e.number! + 1;
      if (lastDate && e.date < lastDate) inversion = true;
      lastDate = e.date > lastDate ? e.date : lastDate;
    }
    if (inversion)
      add({
        code: 'NOT_CHRONOLOGICAL',
        severity: 'warning',
        message: `Journal ${journalCode} : des écritures ne suivent pas l’ordre chronologique de leur numéro.`,
        journalCode,
      });
  }
  return out;
}
