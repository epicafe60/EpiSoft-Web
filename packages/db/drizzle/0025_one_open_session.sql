CREATE TABLE "app"."cash_session_alias" (
	"alias_id" uuid PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- R-SES-05: one drawer, one closing. Sessions open at the same time (one per till until now) are
-- merged into the oldest one: their sales and payments move to it (cash is counted by session),
-- and the id of each merged session stays findable (cash_session_alias).
DO $$
DECLARE
  keep uuid;
  extra record;
BEGIN
  SELECT id INTO keep FROM "app"."cash_session" WHERE status = 'OPEN' ORDER BY opened_at, id LIMIT 1;
  FOR extra IN SELECT id FROM "app"."cash_session" WHERE status = 'OPEN' AND id <> keep LOOP
    INSERT INTO "app"."cash_session_alias" (alias_id, session_id) VALUES (extra.id, keep);
    UPDATE "app"."sale" SET session_id = keep WHERE session_id = extra.id;
    UPDATE "app"."member_payment" SET cash_session_id = keep WHERE cash_session_id = extra.id;
    DELETE FROM "app"."cash_session" WHERE id = extra.id;
  END LOOP;
END $$;
--> statement-breakpoint
DROP INDEX "app"."cash_session_one_open_per_device";--> statement-breakpoint
ALTER TABLE "app"."cash_session_alias" ADD CONSTRAINT "cash_session_alias_session_id_cash_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "app"."cash_session"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cash_session_one_open" ON "app"."cash_session" USING btree ((true)) WHERE "app"."cash_session"."status" = 'OPEN';
--> statement-breakpoint
SELECT "app"."attach_change_capture"();
