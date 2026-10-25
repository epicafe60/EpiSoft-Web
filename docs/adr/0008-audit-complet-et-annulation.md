# ADR 0008 — Audit complet et annulation par l'administrateur

Date: 2026-10-24. Status: implemented.

Request: « que absolument tout soit audité, et qu'une action de retour soit disponible pour
l'administrateur ». Before this, 94 write routes recorded an action, 13 did not, till operations
were mostly silent, `before`/`after` were partial, and a change made by hand in the database (the
till deleted on 2026-10-04 in the development database) left no trace at all.

## Decisions

- **Two levels, linked by the transaction.**
  - `data_change` (migration 0024): a trigger on every table of the schema records each row
    inserted, changed (changed columns only) or deleted, whoever does it. Excluded: the journals
    themselves, login sessions and reset tokens (`app.change_capture_excluded()`). Secrets
    (`*password*`, `*token*`, push keys) are written `"***"`, binary columns as `{"octets": n}`, the
    body of e-mails is not kept. An update that changes nothing, or only a bookkeeping column
    (`pos_device.last_sync_at`), is not recorded.
  - `audit_log` keeps the readable action (who, what, a sentence). Both carry
    `pg_current_xact_id()`: the rows an action changed are exactly those of its transaction.
- **Who writes is labelled on the connection** (`episoft.source`): `app` (the API), `job` (background
  jobs, their own pool), `migration`, `legacy`, `cli:*`; null means someone in psql. AUD-01 flags
  `app` or null changes with no action in the same transaction.
- **Every action is typed.** `AUDIT_SENTENCES` is the list; `audit()` only accepts its keys
  (`AuditAction`). Downloads are recorded by an `onSend` hook (`export.file`) unless the route
  recorded its own action. The API tests fail if the application writes anything without an action
  in the same transaction (`expectAllAttributed`, run by `reset()` and `close()`), and a static test
  checks every write route calls `audit()`.
- **Both journals are append-only** (trigger), except `app.scrub_member()`, called by the
  anonymisation (R-MBR-08), which blanks the personal values recorded about the member.
- **Undo (R-ADM-06)**: `REVERT_POLICIES` (`apps/api/src/modules/admin/revert/policies.ts`) decides,
  for every action, `restore`, `compensate`, `via` (a business screen) or `none` (with the reason).
  The compiler refuses an action without a decision.
  - `restore` is generic: `planRestore()` (pure, `packages/shared/src/revert.ts`) computes the writes
    from the recorded rows and the current state, and refuses when a column was changed since
    (the more recent action is named, it can be undone first). Never applied when the transaction
    wrote history (sales, movements, cagnotte, payments, cash counts): those are compensated.
    E-mails, numbers and price history are left as they are; a price put back gets a new
    price-history line.
  - The preview runs the undo in a transaction that is rolled back: what it shows, including a
    refusal of the database (a row used since, a validated entry), is what the confirmation does.
  - The undo is an action (`audit.revert`, `reverts_id`), with a mandatory reason, and can itself be
    undone.
- **Not retroactive**: entries written before migration 0024 have no transaction id; they are shown
  but cannot be undone from the journal.

## Consequences

- A new table must call `app.attach_change_capture()` at the end of its migration (AUD-02 reminds
  it), and a new action needs a sentence and an undo decision (the compiler says so).
- `data_change` grows with activity (about ten rows per ticket). No purge for now; to watch in the
  database size.
