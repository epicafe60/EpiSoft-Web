CREATE TABLE "app"."backup_run" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"ok" boolean NOT NULL,
	"size_bytes" integer,
	"checksum" text,
	"verified" boolean DEFAULT false NOT NULL,
	"offsite" boolean DEFAULT false NOT NULL,
	"detail" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."error_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"fingerprint" text NOT NULL,
	"message" text NOT NULL,
	"route" text,
	"count" integer DEFAULT 1 NOT NULL,
	"first_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_ref" text NOT NULL,
	"last_member_id" uuid,
	"notified_at" timestamp with time zone,
	"acknowledged_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "app"."integrity_run" (
	"id" uuid PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"errors" integer NOT NULL,
	"warnings" integer NOT NULL,
	"duration_ms" integer NOT NULL,
	"failing" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."sync_rejection" (
	"id" uuid PRIMARY KEY NOT NULL,
	"device_id" uuid,
	"op_id" text NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"reason" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"acknowledged_at" timestamp with time zone,
	"acknowledged_by" uuid
);
--> statement-breakpoint
CREATE TABLE "app"."wallet_snapshot" (
	"day" date NOT NULL,
	"household_id" uuid NOT NULL,
	"balance" numeric(12, 2) NOT NULL,
	CONSTRAINT "wallet_snapshot_day_household_id_pk" PRIMARY KEY("day","household_id")
);
--> statement-breakpoint
ALTER TABLE "app"."error_log" ADD CONSTRAINT "error_log_last_member_id_member_id_fk" FOREIGN KEY ("last_member_id") REFERENCES "app"."member"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."sync_rejection" ADD CONSTRAINT "sync_rejection_device_id_pos_device_id_fk" FOREIGN KEY ("device_id") REFERENCES "app"."pos_device"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."sync_rejection" ADD CONSTRAINT "sync_rejection_acknowledged_by_member_id_fk" FOREIGN KEY ("acknowledged_by") REFERENCES "app"."member"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."wallet_snapshot" ADD CONSTRAINT "wallet_snapshot_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "app"."household"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "error_log_fingerprint_uq" ON "app"."error_log" USING btree ("fingerprint");--> statement-breakpoint
CREATE UNIQUE INDEX "sync_rejection_op_uq" ON "app"."sync_rejection" USING btree ("op_id");--> statement-breakpoint
CREATE INDEX "sync_rejection_at_idx" ON "app"."sync_rejection" USING btree ("at");