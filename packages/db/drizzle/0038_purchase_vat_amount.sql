ALTER TABLE "app"."product" ADD COLUMN "purchase_vat_amount" numeric(12, 4);--> statement-breakpoint
-- Back-fill once so nothing changes visibly: PA TTC = PA HT x (1 + rate) where missing, VAT amount = TTC - HT.
-- From now on the three amounts are typed by hand and never recomputed (R-PRD-04).
UPDATE "app"."product" SET "purchase_price_incl" = round("purchase_price_excl" * (1 + "vat_rate" / 100), 4)
  WHERE "purchase_price_excl" IS NOT NULL AND "purchase_price_incl" IS NULL;--> statement-breakpoint
UPDATE "app"."product" SET "purchase_vat_amount" = "purchase_price_incl" - "purchase_price_excl"
  WHERE "purchase_price_excl" IS NOT NULL AND "purchase_price_incl" IS NOT NULL;
