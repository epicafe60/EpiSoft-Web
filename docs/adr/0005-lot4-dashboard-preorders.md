# ADR 0005 — Lot 4 (so far): dashboard, sortable tables, shop cart and pre-orders

Date: 2026-10-04. Status: proposed, to be confirmed.

## Done

- **Dashboard (R-STA-02)**: `GET /stats/dashboard`, blocks filtered by role (ADMIN sees all). Sales
  are net (a cancellation carries a negative total) over Paris dates; periods to date with the same
  stretch one year earlier (`periodRange`, pure, in `packages/shared/src/stats.ts`).
- **Sortable tables**: `useSort` + `SortTh` (`components/ui/sortable.tsx`), comparison in
  `packages/shared/src/sort.ts` (French collation, natural numbers, empty values last). Sorting is
  done in the browser: the lists load at most 500–1000 rows. Applied to members, products, users,
  suppliers, orders, invoices and entries; other tables can adopt it the same way.
- **Shop and cart (R-PRE-01)**: `/boutique` is open to every signed-in member. The cart lives in
  the browser (localStorage) until it is submitted. Orderable products are active goods whose
  sale condition is `ON_ORDER` or `BOTH`. Prices are indicative: the till charges the price of the
  day; payment is at pick-up (no online payment).
- **Pre-orders**: tables `preorder` / `preorder_line` (migration 0008), numbers `PC-YYYY-NNNN`.
  Statuses: Reçue → Prête → Retirée, or Annulée. A member cancels their own order while it is only
  *Reçue*; the staff (COMMANDES_GESTION) prepares or cancels. `/precommandes` is the staff screen.
- **R-PRE-02**: open orders (Reçue, Prête) are added to the supplier order suggestion
  (`suggestedOrderQtyMilli` third argument), also for a product with no minimum stock.
- **R-PRE-03**: the till lists the open orders (online only), loads one into the ticket (member and
  lines), and the SALE operation carries `preorderId`; the server marks the order *Retirée* and links
  the ticket. If the order is no longer open, the sale is kept and a warning is recorded.

## Defaults taken (to confirm)

- Q5: Epicerio stays in place for now; these pre-orders are the simple v2 version.
- A volunteer keying an order *for* a member is supported by the API (`memberId`), not yet by a
  screen (needs a member picker).
- No stock check at order time (the shop prepares from what it has or orders it, R-PRE-02).
- No e-mail notification when an order is ready yet.

## Left in Lot 4

Statistics screens with filters and margin (R-STA-03), Excel exports and the ADMIN full export
(R-STA-04), saved reports (R-STA-05), Epicerio CSV imports and the generic import wizard
(R-IMP-01..04), the member picker for volunteers, and the "ready" e-mail.
