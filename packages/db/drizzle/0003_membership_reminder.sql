CREATE TABLE "app"."membership_reminder" (
	"membership_id" uuid PRIMARY KEY NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"to" text
);
--> statement-breakpoint
ALTER TABLE "app"."membership_reminder" ADD CONSTRAINT "membership_reminder_membership_id_membership_id_fk" FOREIGN KEY ("membership_id") REFERENCES "app"."membership"("id") ON DELETE cascade ON UPDATE no action;