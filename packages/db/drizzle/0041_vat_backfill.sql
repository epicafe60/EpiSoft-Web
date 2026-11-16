-- R-TVA-03: every existing invoice gets one VAT line carrying its legacy totals, at the standard
-- rate nearest to VAT / HT (0 % when there is no VAT). The real breakdown by rate is unknown, so
-- the line is an approximation: the invoice, its totals and its accounting entries are unchanged.
-- If someone edits such an invoice, the form asks for the true breakdown.
-- R-TVA-07: existing tickets and invoices take the regime LIABLE (the default of the application,
-- column default); no row in vat_regime_change means LIABLE too. Nothing is recomputed.
INSERT INTO "app"."supplier_invoice_vat_line" ("id", "invoice_id", "rate", "excl", "vat")
SELECT gen_random_uuid(), i."id",
  CASE WHEN i."total_excl" <= 0 OR i."total_vat" <= 0 THEN 0
       ELSE (SELECT r FROM unnest(ARRAY[0, 2.1, 5.5, 10, 20]::numeric[]) AS r
              ORDER BY abs(r - i."total_vat" / i."total_excl" * 100), r LIMIT 1) END,
  i."total_excl", i."total_vat"
FROM "app"."supplier_invoice" i
WHERE NOT EXISTS (SELECT 1 FROM "app"."supplier_invoice_vat_line" l WHERE l."invoice_id" = i."id");--> statement-breakpoint
-- R-TVA-04: the VAT accounts of the default chart (collected, per rate; deductible).
INSERT INTO "app"."account" ("id", "number", "label", "normal_side")
VALUES
  (gen_random_uuid(), '445710', 'TVA collectée', 'M'),
  (gen_random_uuid(), '445711', 'TVA collectée 10 %', 'M'),
  (gen_random_uuid(), '445712', 'TVA collectée 20 %', 'M'),
  (gen_random_uuid(), '445713', 'TVA collectée 5,5 %', 'M'),
  (gen_random_uuid(), '445714', 'TVA collectée 2,1 %', 'M'),
  (gen_random_uuid(), '445660', 'TVA déductible sur biens et services', 'M')
ON CONFLICT ("number") DO NOTHING;--> statement-breakpoint
SELECT app.attach_change_capture();
