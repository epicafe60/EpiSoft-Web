CREATE TABLE "app"."email_asset" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"mime" text NOT NULL,
	"bytes" "bytea" NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."email_layout" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"header_image_id" uuid,
	"header_alt" text DEFAULT '' NOT NULL,
	"footer_html" text NOT NULL,
	"accent_color" text NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_layout_single_row" CHECK ("app"."email_layout"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "app"."email_template" (
	"key" text PRIMARY KEY NOT NULL,
	"subject" text NOT NULL,
	"body_html" text NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."email_asset" ADD CONSTRAINT "email_asset_created_by_member_id_fk" FOREIGN KEY ("created_by") REFERENCES "app"."member"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."email_layout" ADD CONSTRAINT "email_layout_header_image_id_email_asset_id_fk" FOREIGN KEY ("header_image_id") REFERENCES "app"."email_asset"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."email_layout" ADD CONSTRAINT "email_layout_updated_by_member_id_fk" FOREIGN KEY ("updated_by") REFERENCES "app"."member"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."email_template" ADD CONSTRAINT "email_template_updated_by_member_id_fk" FOREIGN KEY ("updated_by") REFERENCES "app"."member"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
SELECT app.attach_change_capture();
