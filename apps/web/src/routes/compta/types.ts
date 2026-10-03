import type { EntryModeCode } from '@episoft/shared';

export interface AccountRow {
  id: string;
  number: string;
  label: string;
  normalSide: 'D' | 'C' | 'M';
  active: boolean;
  used?: boolean;
}

export interface JournalRow {
  id: string;
  code: string;
  label: string;
  active: boolean;
}

export interface FiscalYearRow {
  id: string;
  label: string;
  startDate: string;
  endDate: string;
  status: 'OPEN' | 'CLOSED';
  entries: number;
  drafts: number;
}

export interface EntryRow {
  id: string;
  date: string;
  label: string;
  pieceRef: string | null;
  status: 'DRAFT' | 'VALIDATED';
  displayNumber: string | null;
  journalCode: string;
  sourceType: string | null;
  total: string;
  reverses: string | null;
}

export interface EntryDetail {
  id: string;
  journalId: string;
  journalCode: string;
  date: string;
  pieceRef: string | null;
  label: string;
  mode: EntryModeCode | null;
  status: 'DRAFT' | 'VALIDATED';
  displayNumber: string | null;
  sourceType: string | null;
  reversedById: string | null;
  reversesEntryId: string | null;
  lines: {
    id: string;
    accountId: string;
    accountNumber: string;
    accountLabel: string;
    label: string;
    debit: string;
    credit: string;
    reconciliationId: string | null;
    letteringCode: string | null;
  }[];
}

export interface TemplateRow {
  id: string;
  categoryCode: string | null;
  journalId: string;
  journalCode: string;
  label: string;
  mode: EntryModeCode | null;
  active: boolean;
  lines: {
    accountId: string;
    accountNumber: string;
    accountLabel: string;
    label: string;
    debit: string | null;
    credit: string | null;
  }[];
}

export interface TemplateCategory {
  code: string;
  label: string;
}

export interface BankAccountRow {
  id: string;
  label: string;
  iban: string | null;
  accountId: string;
  accountNumber: string;
  active: boolean;
}

export interface StatementRow {
  id: string;
  bankAccountId: string;
  fileName: string;
  format: string;
  periodStart: string | null;
  periodEnd: string | null;
  openingBalance: string;
  closingBalance: string;
  status: 'OPEN' | 'CLOSED';
  lines: number;
  matched: number;
  gap: string;
}

export type Suggestion =
  | { kind: 'ENTRY_LINE'; entryLineId: string; entryId: string; label: string; date: string }
  | { kind: 'INVOICE'; invoiceId: string; label: string; date: string }
  | { kind: 'HOUSEHOLD'; householdId: string; label: string }
  | { kind: 'RULE'; ruleId: string; label: string };

export interface BankLineRow {
  id: string;
  date: string;
  amount: string;
  label: string;
  memo: string | null;
  status: 'NEW' | 'MATCHED';
  entryLineId: string | null;
  suggestions: Suggestion[];
}

export interface StatementDetail {
  id: string;
  bankAccountId: string;
  bankAccountNumber: string;
  fileName: string;
  periodStart: string | null;
  periodEnd: string | null;
  openingBalance: string;
  closingBalance: string;
  status: 'OPEN' | 'CLOSED';
  gap: string;
  lines: BankLineRow[];
}

export interface BankRuleRow {
  id: string;
  priority: number;
  label: string;
  pattern: string;
  matchType: 'CONTAINS' | 'STARTS' | 'REGEX';
  direction: 'IN' | 'OUT' | 'ANY';
  minAmount: string | null;
  maxAmount: string | null;
  counterAccountId: string | null;
  journalId: string | null;
  mode: EntryModeCode | null;
  labelTemplate: string | null;
  householdMatch: boolean;
  supplierId: string | null;
  active: boolean;
}

export interface ReportTableData {
  title: string;
  subtitle?: string;
  columns: { key: string; label: string; type: 'text' | 'money'; width?: number }[];
  rows: { cells: Record<string, string | null>; bold?: boolean }[];
}

export interface ClosingCheckData {
  status: 'OPEN' | 'CLOSED';
  canClose: boolean;
  checks: { code: string; ok: boolean; severity: 'error' | 'warning'; message: string }[];
  stock: { account: string; valuation: string };
}
