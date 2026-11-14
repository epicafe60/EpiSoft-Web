CREATE TABLE "app"."till_cashier_proof" (
	"id" uuid PRIMARY KEY NOT NULL,
	"holder_id" uuid NOT NULL,
	"cashier_id" uuid NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."till_pin_attempt" (
	"id" uuid PRIMARY KEY NOT NULL,
	"cashier_id" uuid NOT NULL,
	"holder_id" uuid,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."till_cashier_proof" ADD CONSTRAINT "till_cashier_proof_holder_id_member_id_fk" FOREIGN KEY ("holder_id") REFERENCES "app"."member"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."till_cashier_proof" ADD CONSTRAINT "till_cashier_proof_cashier_id_member_id_fk" FOREIGN KEY ("cashier_id") REFERENCES "app"."member"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."till_pin_attempt" ADD CONSTRAINT "till_pin_attempt_cashier_id_member_id_fk" FOREIGN KEY ("cashier_id") REFERENCES "app"."member"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."till_pin_attempt" ADD CONSTRAINT "till_pin_attempt_holder_id_member_id_fk" FOREIGN KEY ("holder_id") REFERENCES "app"."member"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "till_cashier_proof_idx" ON "app"."till_cashier_proof" USING btree ("holder_id","cashier_id","issued_at");--> statement-breakpoint
CREATE INDEX "till_pin_attempt_idx" ON "app"."till_pin_attempt" USING btree ("cashier_id","at");--> statement-breakpoint

-- Security bookkeeping, like login_log: the proofs and the wrong codes are not business data, and a
-- wrong code is recorded even though nothing else is written (no journal entry to attach it to).
CREATE OR REPLACE FUNCTION "app"."change_capture_excluded"() RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['audit_log', 'data_change', 'login_log', 'error_log', 'integrity_run', 'backup_run',
               'job_run', 'session', 'password_reset_token', '__drizzle_migrations',
               'till_cashier_proof', 'till_pin_attempt']
$$;
--> statement-breakpoint
SELECT app.attach_change_capture();
