# ADR 0007 — Protections, contrôles et avertissements

Date: 2026-10-24. Status: implemented, to be confirmed by the board.

The legacy application had bugs nobody saw (a closing that broke, a cagnotte debited on the wrong
key, an inventory that zeroed what it did not count…): manual rework and worry. The users are
volunteers. The rule of this ADR: **say more than block**, in plain French, with what to do.

## Decisions

- **Warn and ask, never block the till, never lose a sale** (validated with the board).
  `packages/shared/src/controls.ts` holds the rules as pure functions (`ticketWarnings`,
  `tillHealth`, `clockSkew`, `purchasePriceFlag`, `bulkPriceImpact`, `inventoryImpact`,
  `walletMoveNeedsConfirm`, `similarNames`, `suggestEmailDomain`, `memberDuplicates`); the till,
  the API and the tests share them. A warning at the till is a window « Vérifiez avant d'encaisser »
  (Corriger / C'est correct). The server mirrors it: the sale is recorded, the warning is stored on it
  (`sale.warnings`) and listed in Surveillance until someone marks it « Vu ».
- **Thresholds** are one setting, `controls.thresholds` (Administration › Paramètres › Seuils
  d'alerte, with « Remettre les valeurs par défaut »). The till gets them in its snapshot and works
  offline with the values it last received.
- **A refused operation is kept.** `sync_rejection` stores what the server refused, the
  administrators are e-mailed at once (once an hour at most), the cashier finds the ticket in
  « Tickets du jour » and can enter it again. An operation that arrives *before* what it depends on
  (a cancellation ahead of its ticket, a ticket ahead of its session) is answered « not yet »
  (409), stored nowhere, and sent again by the till: it is never turned into a final refusal.
- **One operation id per ticket**, fixed in the draft, plus an in-flight guard: a double click on
  « Valider le ticket » cannot make two tickets.
- **« À surveiller »** (`GET /admin/attention`) is the one list the home block, the daily e-mail and
  the tests read. One summary e-mail each morning; refused ticket, missed backup and server error
  are e-mailed at once. Unexpected errors get a reference (`error_log`) the user can read out.
- **Backups report to the application** (`/internal/backup-report`, shared secret
  `BACKUP_REPORT_TOKEN`): `backup.sh` verifies the dump with `pg_restore -l`, writes a checksum,
  copies off-site when configured; `restore-test.sh` restores into a scratch database monthly and
  compares it with the live data. systemd timers are provided. A late or failed backup shows in
  « À surveiller ». The documented restore now uses `pg_restore` (the dump is in custom format).
- **New integrity checks**: SYN-01, SES-01, SES-02, VTE-06, FAC-02, MEM-01, CAG-05 (the daily
  cagnotte snapshot: yesterday's balance + today's movements = today's balance), MAIL-01, BKP-01.
  The history of runs is kept (`integrity_run`), and a restart no longer skips the daily alert.
- **No rule code (R-xxx) in anything a user reads**; `wording.test.ts` enforces it, and that the
  application's own confirmation window (`components/confirm.tsx`, with the consequences listed)
  replaces `window.confirm`/`prompt` everywhere.
- **A plain-language « Derniers changements »** feed (`audit-sentences.ts`) and a « Que faire si… »
  help page (`/aide`). A test checks that every audited action has a sentence.
- Heavy exports (`/admin/export.xlsx`, `/me/export`) and `/sync/push` are rate limited.

## Defaults taken (to confirm)

- The thresholds listed in `DEFAULT_THRESHOLDS`.
- The e-mail alerts go to the ADMIN and COMPTA roles (the administrators for server errors).
- The off-site copy of the backups still has to be configured on the server (rsync or rclone).
- An outside uptime monitor for « the server is down altogether » is recommended in the
  maintenance guide, not installed.

## Not done

- Merging two member cards (the duplicate is detected and shown; merging stays manual).
- A general « undo », and a trash for deleted drafts.
