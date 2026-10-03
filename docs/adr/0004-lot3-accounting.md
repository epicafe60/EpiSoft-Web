# ADR 0004 — Lot 3 (accounting): choices and what is left

Date: 2026-10-04. Status: proposed, to be confirmed.

## Choices

1. **Entries are drafts until validated; the number is given at validation** (R-CPT-05), per
   journal and fiscal year, in date then creation order, from `number_counter` (key
   `entry:<journal>:<fiscal year>`). This differs from the old app, which numbered at creation, and
   gives the continuous numbering the FEC needs. The numbers shown are `ACH-2026-0001`.
2. **The database refuses what the rules forbid**: triggers `entry_guard` and `entry_line_guard`
   block any change to a validated entry (only reconciliation and lettering markers may move),
   an exclusion constraint forbids overlapping fiscal years. Reopening a year (ADMIN, audited) and
   the legacy migration switch the guard off for their own transaction only
   (`set_config('app.bypass_entry_guard', 'on', true)`).
3. **Automatic entries** are keyed by `entry.source_type / source_id` (session, invoice,
   invoice_payment, bank_line, deposit, closing_*), so regenerating is idempotent. The cash session
   entry is written inside a savepoint: if it fails, the closing of the session is not lost, the
   entry is generated again from the accounting screen.
4. **Fiscal year of an automatic entry**: the year covering the date; if none exists, the calendar
   year is created open. A closed year refuses new entries.
5. **Q1 (VAT)**: the association is not liable to VAT, so the invoice goes to the expense
   account **TTC**. The VAT columns stay on the invoice for information.
6. **Q6 (sales accounts)**: one account, `707000`. The settings page lets the treasurer give
   other accounts (`accounting.accounts`) without code change.
7. **Wallet (cagnotte)** is a liability: `411000` is credited by top-ups and debited by sales.
8. **Year-end closing (R-CPT-18)**: checks (drafts, unmatched bank lines, balance, previous year
   closed), stock variation from the valuation at the last day (`603700` / `370000`), result entry
   (OD) to `120000` / `129000`, year locked, next year created, opening balances (journal RAN) on
   its first day. Reopening deletes these three kinds of entries. Income reports exclude the
   result entry (`source_type = closing_result`) so that a closed year still shows its income.
9. **Bank**: statements are imported as OFX / CSV / CAMT; a line is deduplicated by FITID or by
   `date|amount|label#n`; the opening balance is the closing one minus the new lines. A statement
   closes only when every line is matched and the gap is zero (R-CPT-14).
10. **Reports** are one structure (`ReportTable`) rendered as JSON for the screen, Excel
    (ExcelJS) and PDF (pdfkit). The FEC is refused while drafts remain.

## Legacy migration (lot 3 part)

- Accounts: types C / D / M become the normal side. Journals, fiscal years (calendar: 2025 closed,
  2026 open), 260 of 261 movements. Past years' entries are VALIDATED and numbered in date order;
  the current year stays DRAFT, to be validated by the treasurer.
- Amounts are rounded to 2 decimals (the old columns were floats). A line with both a debit and a
  credit is split. **Credit notes keyed as negative amounts** (movements 169 and 258) are moved to
  the opposite side, which keeps them balanced. Movement 55 has no lines and is reported.
- `MVTRAPP` (month of the statement) becomes one historical reconciliation per value, set on the
  512 lines. These are not tied to a statement: the treasurer reconciles new statements from the
  application.
- **Legacy RAN (open point)**: the two RAN movements (36 and 96) are kept as they are. Movement 36
  uses `890000` as counterpart; it is flagged, because the v2 closing produces its own
  opening balances and the 2026 year will therefore show both. To settle with the treasurer
  before the first v2 closing.
- `ecritures1` (Oct–Dec 2025, old format) is **archived in the migration report and not
  migrated** (Q7, default "archive after verification").
- Guides: 8-digit accounts are shortened to six digits; `51211000` becomes the bank account. Missing
  accounts (615000, 616100, 627000) are created.
- Bank rules come from `Datas/Models.txt` in file order (the first match won), the direction
  follows the side of the 512 account, "REMISE DE CHEQUE" is fixed to `511200` (anomaly C15) and
  "FAVEUR" marks a household transfer.
- Supplier invoices from lot 2 are linked to their existing ACH entries (same supplier account and
  amount, closest date within 60 days) and payments to BNQ / CAI entries, so that the application
  does not generate them a second time. The rest is reported and gets its entry on the next action.
- The report holds a sheet "Balance par compte" (source vs target, net per account): zero gap on
  all accounts at the last run.

## What is left

- Server deployment (Q9) and the treasurer's decisions listed in the migration report.
- End-to-end browser scenario for the accounting screens.
