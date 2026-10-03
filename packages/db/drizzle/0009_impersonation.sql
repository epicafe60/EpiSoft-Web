ALTER TABLE "app"."audit_log" ADD COLUMN "on_behalf_of_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."session" ADD COLUMN "acting_as_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."audit_log" ADD CONSTRAINT "audit_log_on_behalf_of_id_member_id_fk" FOREIGN KEY ("on_behalf_of_id") REFERENCES "app"."member"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."session" ADD CONSTRAINT "session_acting_as_id_member_id_fk" FOREIGN KEY ("acting_as_id") REFERENCES "app"."member"("id") ON DELETE set null ON UPDATE no action;