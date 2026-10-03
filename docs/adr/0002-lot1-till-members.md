# ADR 0002 — Lot 1 (till and members): choices and what is left

Date: 2026-10-03. Status: proposed, to be confirmed.

## Choices that refine the specification

1. **The sale id is the operation id.** The device generates one UUID per ticket; it is
   both the idempotency key (§8.3) and `sale.id` (§6.2).
2. **Sessions can be opened offline.** A `SESSION_OPEN` operation is added to the four
   kinds of R-SYNC-01: the device generates the session id, so a day can start without
   network (§5.3). Closing still needs the network (R-OFF-07).
3. **Every sale goes through the outbox, online or not.** There is one code path; online,
   the ticket is sent immediately after being stored locally.
4. **Snapshot.** Products and members are incremental (`updated_at`); households (balance,
   membership end) are always sent in full — they are few and must be exact.
5. **Offline overdraft.** The till refuses a cagnotte payment beyond the limit unless a
   user with the `ADHERENTS` role forces it (logged). A sale made offline with a stale
   balance is accepted by the server with a warning (R-SYNC-04).
6. **Cashier switch by badge (R-AUTH-04)** is checked on the device against the hashed
   badges of the snapshot, so it works offline. The server checks the cashier's role when
   the sale arrives and records a warning if needed. No `POST /auth/badge` endpoint.
7. **Price of a membership.** Changing a membership type's price also changes its service
   product, which is what the till sells (R-ADH-05).
8. **Line total rounding**: half away from zero, to the cent, per line (§5.2).

## Legacy migration (lot 1 part)

- Tickets keep their EpiSoft number (`T-<year>-<TICKNUM>`) and total; 127 tickets whose
  lines do not add up to the total (EpiSoft rounding) keep the original total, so monthly
  sales are equal to the cent (§9.2). Sessions are rebuilt per day, with a float of 0
  (unknown) and no cash count.
- The 38 tickets still in `tmptickets` (EpiSoft closing broken, anomaly C1) are migrated
  with numbers following the last ticket and re-imported at each run. At switch-over,
  they must be closed in EpiSoft first, or migrated this way (§9.3).
- Historical sales create no stock movement: the opening stock is `PRODSTOCK` (§9.1).
- 64 products carry their own code in the EAN field: ignored (the till finds them by code).
- Cagnotte: 46 households show a gap between tickets paid by cagnotte and the 01011
  debits (anomaly C2), and 4 between `ADHSOLDE` and the payments. The balance migrated is
  the sum of the payments; the "Cagnottes" sheet of the report is for the treasurer to
  decide corrections (§9.1).

## Not done in lot 1

| Item | Reason / plan |
|---|---|
| Accounting draft entry at closing (R-SES-02 step 5) | Needs the accounts and journals of lot 3 |
| Bank deposits and cheque slips (R-SES-04) | Feeds accounting; with lot 3. The deposit amount is recorded in the closing |
| Closing report as PDF | E-mailed as HTML and printable from the browser; PDF with the lot 2 PDF tooling |
| 80 mm ticket printing (R-VTE-13, Q3) | Q3 default is e-mail; to do if the shop wants a printer |
| Scale barcodes (R-VTE-04 [nouveau]) | Needs the label format of the scale |
| Cagnotte history export Excel/PDF (R-CAG-07) | With the exports of lot 4 |
| Membership reminder J−15 (R-ADH-04), top-up edit on the same day (R-CAG-08) | Optional; corrections cover R-CAG-08 |
| Offline reload test | The e2e tests run on the Vite dev server, which has no service worker; reloading offline is to be checked on a production build |
