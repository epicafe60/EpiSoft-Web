# ADR 0003 — Lot 2 (supplies and stock): choices and what is left

Date: 2026-10-03. Status: proposed, to be confirmed.

## Choices

1. **PDF documents with pdfkit and bwip-js** (pure JavaScript, no system binary): purchase
   orders, label sheets, closing reports. Spec §7.2 suggested Typst or Playwright; both
   need a binary or a browser in the server image.
2. **One stock ledger helper** for every movement (sales, receipts, losses, corrections,
   inventories): the cached `product.stock_qty` is always updated in the same transaction,
   so it equals the sum of the movements (R-STK-01/02).
3. **Margin (open question Q2)**: default markup rate on the selling price TTC,
   `(PV − PA TTC) / PV`, with the coefficient `PV / PA TTC` also shown; target 25 % and
   5-cent rounding by default, editable in the settings. The receipt screen suggests a
   new price from it; the user decides.
4. **Inventory**: the adjustment of a counted product is
   `counted − (theoretical at opening + movements between opening and count)`, so a sale
   made while counting is neither lost nor counted twice; uncounted products are untouched
   unless "set to zero" is explicitly chosen (R-STK-04, both CA).
5. **Supplier 401 account** is proposed as the next free `401NNN` number at creation
   (R-FNR-01); it becomes a real account in lot 3.
6. **Valuation at a date** uses the last purchase price recorded in the price history
   before that date, or the current one (R-STK-06).
7. **Invoice documents** are stored in the database (`media`), like product images. Limit
   10 MB per document.

## Legacy migration (lot 2 part)

- Orders keep their EpiSoft id in the number (`CF-<year>-<FNRCOMID>`); status 3 orders get
  a receipt document, without stock movement (the opening stock already includes it).
- Invoices: TTC = HT + VAT enforced, ambiguous payment modes left empty, duplicate pieces
  suffixed, document links kept in the comment; all listed in the report.
- Inventories are kept as history; no stock is replayed.
- Tested as a dry run on the local EpiSoft copy (older than production). The real run is
  to be done from production (`--remote`).

## Left for later lots

| Item | Lot |
|---|---|
| Accounting entries of invoices and payments, lettering (R-FAC-03/04) | 3 |
| Optional accounting entry for losses (R-STK-03) | 3 |
| Stock valuation posted to 370000 (R-STK-06) | 3 |
| Reservations in the suggested quantity (R-CMD-01) | 4 (pre-orders) |
| Supplier returns (`SUPPLIER_RETURN` movements): the kind exists, no screen yet | when needed |
