-- Product information, organic claim, traceability and consent records.

-- A consent is evidence: the application adds rows (a withdrawal is a new row) and never rewrites one.
CREATE TRIGGER "history_guard" BEFORE UPDATE ON "app"."consent"
  FOR EACH ROW EXECUTE FUNCTION "app"."history_guard"();--> statement-breakpoint

-- The products of the food universes (1 épicerie salée, 2 épicerie sucrée, 3 produits frais, 4 liquides)
-- are marked as food: their allergen decision, ingredients and origin are still to be filled in, and
-- « À surveiller » lists them until they are.
UPDATE "app"."product" p SET "is_food" = true
  FROM "app"."category" c JOIN "app"."universe" u ON u."id" = c."universe_id"
  WHERE p."category_id" = c."id" AND p."kind" = 'GOODS' AND u."code" IN ('1', '2', '3', '4');--> statement-breakpoint

-- What the member sheet already recorded becomes the first rows of the consent history.
INSERT INTO "app"."consent" ("id", "member_id", "purpose", "granted", "text_version", "channel", "at")
  SELECT gen_random_uuid(), m."id", 'IMAGE_RIGHTS', true, 'avant-2026-11', 'MIGRATION', m."image_consent_at"
  FROM "app"."member" m WHERE m."image_consent_at" IS NOT NULL;--> statement-breakpoint
INSERT INTO "app"."consent" ("id", "member_id", "purpose", "granted", "text_version", "channel", "at")
  SELECT gen_random_uuid(), m."id", 'NEWSLETTER', true, 'avant-2026-11', 'MIGRATION', m."newsletter_opt_in_at"
  FROM "app"."member" m WHERE m."newsletter_opt_in_at" IS NOT NULL;--> statement-breakpoint
INSERT INTO "app"."consent" ("id", "member_id", "purpose", "granted", "text_version", "channel", "at")
  SELECT gen_random_uuid(), m."id", 'EMAIL_RECEIPTS', false, 'avant-2026-11', 'MIGRATION', m."updated_at"
  FROM "app"."member" m WHERE m."ticket_email_opt_out";--> statement-breakpoint

SELECT app.attach_change_capture();
