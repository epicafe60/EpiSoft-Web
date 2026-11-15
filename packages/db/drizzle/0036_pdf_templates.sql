CREATE TABLE "app"."pdf_template" (
	"key" text PRIMARY KEY NOT NULL,
	"config" jsonb NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."pdf_template" ADD CONSTRAINT "pdf_template_updated_by_member_id_fk" FOREIGN KEY ("updated_by") REFERENCES "app"."member"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
SELECT app.attach_change_capture();
