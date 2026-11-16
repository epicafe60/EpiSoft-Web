CREATE TABLE "app"."fiscal_journal" (
	"id" uuid PRIMARY KEY NOT NULL,
	"seq" integer NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"kind" text NOT NULL,
	"ref_type" text NOT NULL,
	"ref_id" uuid NOT NULL,
	"data" jsonb NOT NULL,
	"prev_hash" text NOT NULL,
	"hash" text NOT NULL,
	"signature" text,
	CONSTRAINT "fiscal_journal_seq_unique" UNIQUE("seq")
);
--> statement-breakpoint
CREATE TABLE "app"."period_closing" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"closed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_by" uuid,
	"tickets" integer NOT NULL,
	"cancellations" integer NOT NULL,
	"returns" integer NOT NULL,
	"sales_total" numeric(12, 2) NOT NULL,
	"refunds_total" numeric(12, 2) NOT NULL,
	"net_total" numeric(12, 2) NOT NULL,
	"grand_total" numeric(14, 2) NOT NULL,
	"totals" jsonb NOT NULL,
	"journal_seq" integer NOT NULL,
	CONSTRAINT "period_closing_kind" CHECK ("app"."period_closing"."kind" in ('DAY', 'MONTH', 'YEAR'))
);
--> statement-breakpoint
CREATE TABLE "app"."ticket_reprint" (
	"id" uuid PRIMARY KEY NOT NULL,
	"sale_id" uuid NOT NULL,
	"copy_no" integer NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"cashier_id" uuid,
	"device_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."sale" ADD COLUMN "register_seq" integer;--> statement-breakpoint
ALTER TABLE "app"."sale" ADD COLUMN "till_hash" text;--> statement-breakpoint
ALTER TABLE "app"."sale" ADD COLUMN "till_prev_hash" text;--> statement-breakpoint
ALTER TABLE "app"."sale" ADD COLUMN "till_seal_status" text;--> statement-breakpoint
ALTER TABLE "app"."sale" ADD COLUMN "accounting_day" date DEFAULT '1970-01-01' NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."sale" ADD COLUMN "returns_sale_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."sale" ADD COLUMN "return_reason" text;--> statement-breakpoint
ALTER TABLE "app"."sale" ADD COLUMN "refund_method" "app"."payment_method";--> statement-breakpoint
ALTER TABLE "app"."sale_line" ADD COLUMN "returns_line_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."period_closing" ADD CONSTRAINT "period_closing_closed_by_member_id_fk" FOREIGN KEY ("closed_by") REFERENCES "app"."member"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."ticket_reprint" ADD CONSTRAINT "ticket_reprint_sale_id_sale_id_fk" FOREIGN KEY ("sale_id") REFERENCES "app"."sale"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."ticket_reprint" ADD CONSTRAINT "ticket_reprint_cashier_id_member_id_fk" FOREIGN KEY ("cashier_id") REFERENCES "app"."member"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."ticket_reprint" ADD CONSTRAINT "ticket_reprint_device_id_pos_device_id_fk" FOREIGN KEY ("device_id") REFERENCES "app"."pos_device"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fiscal_journal_ref_idx" ON "app"."fiscal_journal" USING btree ("ref_type","ref_id");--> statement-breakpoint
CREATE UNIQUE INDEX "period_closing_one" ON "app"."period_closing" USING btree ("kind","period_start");--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_reprint_copy" ON "app"."ticket_reprint" USING btree ("sale_id","copy_no");--> statement-breakpoint
ALTER TABLE "app"."sale" ADD CONSTRAINT "sale_returns_sale_id_sale_id_fk" FOREIGN KEY ("returns_sale_id") REFERENCES "app"."sale"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."sale_line" ADD CONSTRAINT "sale_line_returns_line_id_sale_line_id_fk" FOREIGN KEY ("returns_line_id") REFERENCES "app"."sale_line"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sale_accounting_day_idx" ON "app"."sale" USING btree ("accounting_day");--> statement-breakpoint
CREATE INDEX "sale_device_register_idx" ON "app"."sale" USING btree ("device_id","register_seq");--> statement-breakpoint
CREATE INDEX "sale_returns_idx" ON "app"."sale" USING btree ("returns_sale_id") WHERE "app"."sale"."returns_sale_id" is not null;