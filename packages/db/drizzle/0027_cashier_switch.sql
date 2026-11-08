ALTER TABLE "app"."audit_log" ADD COLUMN "via_session_of_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."member" ADD COLUMN "till_password_hash" text;--> statement-breakpoint
ALTER TABLE "app"."member" ADD COLUMN "till_password_salt" text;--> statement-breakpoint
ALTER TABLE "app"."session" ADD COLUMN "till_cashier_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."audit_log" ADD CONSTRAINT "audit_log_via_session_of_id_member_id_fk" FOREIGN KEY ("via_session_of_id") REFERENCES "app"."member"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."session" ADD CONSTRAINT "session_till_cashier_id_member_id_fk" FOREIGN KEY ("till_cashier_id") REFERENCES "app"."member"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

-- R-SES-07: the capture masks the new columns of the cashier code (their name holds « password »);
-- the masks are computed when the trigger is attached.
SELECT app.attach_change_capture();
