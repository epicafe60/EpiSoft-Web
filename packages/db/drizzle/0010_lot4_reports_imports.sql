CREATE TABLE "app"."import_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"file_name" text NOT NULL,
	"file_hash" text NOT NULL,
	"summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."import_mapping" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"source_key" text NOT NULL,
	"target" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."saved_report" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"shared" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."import_log" ADD CONSTRAINT "import_log_created_by_member_id_fk" FOREIGN KEY ("created_by") REFERENCES "app"."member"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."saved_report" ADD CONSTRAINT "saved_report_created_by_member_id_fk" FOREIGN KEY ("created_by") REFERENCES "app"."member"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "import_log_kind_idx" ON "app"."import_log" USING btree ("kind","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "import_mapping_uq" ON "app"."import_mapping" USING btree ("kind","source_key");--> statement-breakpoint
CREATE INDEX "saved_report_author_idx" ON "app"."saved_report" USING btree ("created_by");