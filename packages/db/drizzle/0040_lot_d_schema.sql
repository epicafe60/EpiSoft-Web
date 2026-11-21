CREATE TYPE "app"."supplier_credit_note_status" AS ENUM('ACTIVE', 'CANCELLED');--> statement-breakpoint
ALTER TYPE "app"."supplier_invoice_status" ADD VALUE 'CANCELLED';--> statement-breakpoint
CREATE TABLE "app"."supplier_credit_allocation" (
	"id" uuid PRIMARY KEY NOT NULL,
	"credit_note_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"date" date NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_credit_allocation_positive" CHECK ("app"."supplier_credit_allocation"."amount" > 0)
);
--> statement-breakpoint
CREATE TABLE "app"."supplier_credit_note" (
	"id" uuid PRIMARY KEY NOT NULL,
	"supplier_id" uuid NOT NULL,
	"invoice_id" uuid,
	"piece_ref" text NOT NULL,
	"date" date NOT NULL,
	"total_excl" numeric(12, 2) NOT NULL,
	"total_vat" numeric(12, 2) DEFAULT '0' NOT NULL,
	"total_incl" numeric(12, 2) NOT NULL,
	"status" "app"."supplier_credit_note_status" DEFAULT 'ACTIVE' NOT NULL,
	"expense_account_number" text,
	"entry_id" uuid,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"cancel_entry_id" uuid,
	"comment" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_credit_note_positive" CHECK ("app"."supplier_credit_note"."total_incl" > 0)
);
--> statement-breakpoint
DROP INDEX "app"."supplier_invoice_piece_uq";--> statement-breakpoint
ALTER TABLE "app"."fiscal_year" ADD COLUMN "approved_on" date;--> statement-breakpoint
ALTER TABLE "app"."fiscal_year" ADD COLUMN "approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app"."fiscal_year" ADD COLUMN "approved_by" uuid;--> statement-breakpoint
ALTER TABLE "app"."fiscal_year" ADD COLUMN "approval_reference" text;--> statement-breakpoint
ALTER TABLE "app"."product" ADD COLUMN "avg_cost" numeric(14, 6);--> statement-breakpoint
ALTER TABLE "app"."stock_movement" ADD COLUMN "avg_cost_after" numeric(14, 6);--> statement-breakpoint
ALTER TABLE "app"."supplier_invoice" ADD COLUMN "cancelled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app"."supplier_invoice" ADD COLUMN "cancelled_by" uuid;--> statement-breakpoint
ALTER TABLE "app"."supplier_invoice" ADD COLUMN "cancel_reason" text;--> statement-breakpoint
ALTER TABLE "app"."supplier_invoice" ADD COLUMN "cancel_entry_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."supplier_credit_allocation" ADD CONSTRAINT "supplier_credit_allocation_credit_note_id_supplier_credit_note_id_fk" FOREIGN KEY ("credit_note_id") REFERENCES "app"."supplier_credit_note"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."supplier_credit_allocation" ADD CONSTRAINT "supplier_credit_allocation_invoice_id_supplier_invoice_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "app"."supplier_invoice"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."supplier_credit_allocation" ADD CONSTRAINT "supplier_credit_allocation_created_by_member_id_fk" FOREIGN KEY ("created_by") REFERENCES "app"."member"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."supplier_credit_note" ADD CONSTRAINT "supplier_credit_note_supplier_id_supplier_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "app"."supplier"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."supplier_credit_note" ADD CONSTRAINT "supplier_credit_note_invoice_id_supplier_invoice_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "app"."supplier_invoice"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."supplier_credit_note" ADD CONSTRAINT "supplier_credit_note_entry_id_entry_id_fk" FOREIGN KEY ("entry_id") REFERENCES "app"."entry"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."supplier_credit_note" ADD CONSTRAINT "supplier_credit_note_cancel_entry_id_entry_id_fk" FOREIGN KEY ("cancel_entry_id") REFERENCES "app"."entry"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."supplier_credit_note" ADD CONSTRAINT "supplier_credit_note_created_by_member_id_fk" FOREIGN KEY ("created_by") REFERENCES "app"."member"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "supplier_credit_allocation_invoice_idx" ON "app"."supplier_credit_allocation" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "supplier_credit_allocation_note_idx" ON "app"."supplier_credit_allocation" USING btree ("credit_note_id");--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_credit_note_piece_uq" ON "app"."supplier_credit_note" USING btree ("supplier_id","piece_ref") WHERE "app"."supplier_credit_note"."cancelled_at" is null;--> statement-breakpoint
CREATE INDEX "supplier_credit_note_supplier_idx" ON "app"."supplier_credit_note" USING btree ("supplier_id","date");--> statement-breakpoint
ALTER TABLE "app"."fiscal_year" ADD CONSTRAINT "fiscal_year_approved_by_member_id_fk" FOREIGN KEY ("approved_by") REFERENCES "app"."member"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."supplier_invoice" ADD CONSTRAINT "supplier_invoice_cancelled_by_member_id_fk" FOREIGN KEY ("cancelled_by") REFERENCES "app"."member"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."supplier_invoice" ADD CONSTRAINT "supplier_invoice_cancel_entry_id_entry_id_fk" FOREIGN KEY ("cancel_entry_id") REFERENCES "app"."entry"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_invoice_piece_uq" ON "app"."supplier_invoice" USING btree ("supplier_id","piece_ref") WHERE "app"."supplier_invoice"."cancelled_at" is null;
