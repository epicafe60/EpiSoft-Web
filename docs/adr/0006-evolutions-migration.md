# ADR 0006 — Evolutions requested for the migration (docs/evols)

Date: 2026-10-24. Status: implemented, to be confirmed by the board.

Source: `docs/evols/Expression de besoins - migration.xlsx`, consolidated in
`docs/evols/01-besoins-consolides.md`, specified in `02-specifications-evolutions.md`
(rules `R-EVO-nn`), planned in `03-plan-implementation.md`.

## Decisions

- **Member before the first line (R-EVO-01)**: a member, a passing membership or a donation is
  needed before any article. New switch `pos.options.requireMemberFirst` (default on, in the
  administration screen) puts the old behaviour back. The amount of the passing membership is
  edited in the line dialog (already traced: catalogue price kept next to the price charged).
- **No default payment method (R-EVO-02).**
- **Donation (R-EVO-08)**: a « Don » button adds the service product `01004`, amount typed by
  the cashier; it already lands on account 754 at closing. No new operation type.
- **Shared session (R-EVO-06)**: a session belongs to the shop, not to the till that opened it.
  The snapshot lists the open sessions (`settings.openSessions`); a second till *joins* one
  (no `SESSION_OPEN`, no float) and its sales carry that session id. The sync service accepts a
  session opened by another till. The drawer is counted once, by whichever till closes;
  sub-totals by cashier and the list of tills are in the summary, the report and the PDF. A till
  that is offline when it starts still opens its own session (separate drawer): offline opening
  stays possible. A till that sees its session closed elsewhere forgets it at the next refresh;
  its queued tickets are still recorded, with the usual « session clôturée » warning.
- **Ticket e-mail (R-EVO-40)**: sent automatically after each sale and top-up to a member with an
  address who did not opt out (`member.ticket_email_opt_out`), with the cagnotte before and after.
  `email.enabled` still switches every e-mail off.
- **Image consent (R-EVO-44)**: `member.image_consent_at`; shown in the member Excel export.
- **Inventory (R-EVO-30)**: `inventory_session.freeze_sales` makes the till refuse new tickets
  (snapshot `salesFrozen`); tickets already queued are still recorded. Count sheet in Excel.
- **Receipt correction (R-EVO-11)**: `POST /receipts/:id/correct`, stock follows through a
  `CORRECTION` movement, refused once an invoice including the receipt is paid. Default for Q4.
- **Login by e-mail (R-EVO-42)**; **cagnotte report by household (R-EVO-50)**;
  **opening-balance check (R-EVO-51)**; **supplier data audit (R-EVO-15)**.

## Defaults taken (to confirm)

- Q3: fiscal year July–June. The opening-balance check works whatever the year.
- Q5: the inventory freeze is optional and off by default.
- Q6: one supplier per product.
- Q8: a donation needs no member; no tax receipt.
- Reopening a closed till session: the API accepts ADMIN and COMPTA; the screen is still the
  administration one (ADMIN only).

## Not done

- R-EVO-14 « identical to the current order form »: needs a sample of the v1 PDF to compare.
- Receiving an order from the till (R-EVO-11, third point): the receipt shows who keyed it in,
  but the receive screen stays in the supplies module.
- Hosting and security notes (EV-T02, EV-T03): see `docs/maintenance.md`; the off-site copy of
  the backups is still to be set up on the server.
