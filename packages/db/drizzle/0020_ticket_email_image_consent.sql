ALTER TABLE "app"."member" ADD COLUMN "ticket_email_opt_out" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."member" ADD COLUMN "image_consent_at" timestamp with time zone;