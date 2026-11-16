CREATE TABLE "app"."db_size_snapshot" (
	"id" uuid PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"total_bytes" bigint NOT NULL,
	"tables" jsonb NOT NULL,
	"reason" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "db_size_snapshot_at_idx" ON "app"."db_size_snapshot" USING btree ("at");