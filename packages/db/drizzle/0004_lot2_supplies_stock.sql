CREATE TYPE "app"."inventory_status" AS ENUM('OPEN', 'VALIDATED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "app"."purchase_order_status" AS ENUM('DRAFT', 'SENT', 'PARTIAL', 'RECEIVED', 'CLOSED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "app"."supplier_invoice_status" AS ENUM('TO_PAY', 'PAID');--> statement-breakpoint
CREATE TYPE "app"."supplier_payment_method" AS ENUM('CASH', 'CHEQUE', 'CARD', 'TRANSFER', 'DIRECT_DEBIT');--> statement-breakpoint
CREATE TABLE "app"."goods_receipt" (
	"id" uuid PRIMARY KEY NOT NULL,
	"number" text NOT NULL,
	"order_id" uuid,
	"supplier_id" uuid NOT NULL,
	"date" date NOT NULL,
	"received_by" uuid,
	"comment" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"legacy_fnrcomid" integer,
	CONSTRAINT "goods_receipt_number_unique" UNIQUE("number"),
	CONSTRAINT "goods_receipt_legacy_fnrcomid_unique" UNIQUE("legacy_fnrcomid")
);
--> statement-breakpoint
CREATE TABLE "app"."goods_receipt_line" (
	"id" uuid PRIMARY KEY NOT NULL,
	"receipt_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"product_id" uuid NOT NULL,
	"qty" numeric(12, 3) NOT NULL,
	"unit_price_excl" numeric(12, 4) NOT NULL,
	"vat_rate" numeric(5, 2) NOT NULL,
	"order_line_id" uuid,
	CONSTRAINT "goods_receipt_line_qty_positive" CHECK ("app"."goods_receipt_line"."qty" > 0)
);
--> statement-breakpoint
CREATE TABLE "app"."inventory_line" (
	"session_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"theoretical_qty" numeric(12, 3) NOT NULL,
	"counted_qty" numeric(12, 3),
	"counted_at" timestamp with time zone,
	"counted_by" uuid,
	"unit_cost_excl" numeric(12, 4),
	"unit_cost_incl" numeric(12, 4),
	"adjustment" numeric(12, 3),
	CONSTRAINT "inventory_line_session_id_product_id_pk" PRIMARY KEY("session_id","product_id")
);
--> statement-breakpoint
CREATE TABLE "app"."inventory_session" (
	"id" uuid PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"scope" jsonb NOT NULL,
	"status" "app"."inventory_status" DEFAULT 'OPEN' NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"opened_by" uuid,
	"validated_at" timestamp with time zone,
	"validated_by" uuid,
	"zero_uncounted" boolean DEFAULT false NOT NULL,
	"legacy_date" date,
	CONSTRAINT "inventory_session_legacy_date_unique" UNIQUE("legacy_date")
);
--> statement-breakpoint
CREATE TABLE "app"."invoice_receipt" (
	"invoice_id" uuid NOT NULL,
	"receipt_id" uuid NOT NULL,
	CONSTRAINT "invoice_receipt_invoice_id_receipt_id_pk" PRIMARY KEY("invoice_id","receipt_id")
);
--> statement-breakpoint
CREATE TABLE "app"."purchase_order" (
	"id" uuid PRIMARY KEY NOT NULL,
	"number" text NOT NULL,
	"supplier_id" uuid NOT NULL,
	"date" date NOT NULL,
	"status" "app"."purchase_order_status" DEFAULT 'DRAFT' NOT NULL,
	"comment" text,
	"total_excl" numeric(12, 2) DEFAULT '0' NOT NULL,
	"total_vat" numeric(12, 2) DEFAULT '0' NOT NULL,
	"total_incl" numeric(12, 2) DEFAULT '0' NOT NULL,
	"sent_at" timestamp with time zone,
	"sent_to" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"legacy_fnrcomid" integer,
	CONSTRAINT "purchase_order_number_unique" UNIQUE("number"),
	CONSTRAINT "purchase_order_legacy_fnrcomid_unique" UNIQUE("legacy_fnrcomid")
);
--> statement-breakpoint
CREATE TABLE "app"."purchase_order_line" (
	"id" uuid PRIMARY KEY NOT NULL,
	"order_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"product_id" uuid NOT NULL,
	"qty_ordered" numeric(12, 3) NOT NULL,
	"unit_price_excl" numeric(12, 4) NOT NULL,
	"vat_rate" numeric(5, 2) NOT NULL,
	"qty_received" numeric(12, 3) DEFAULT '0' NOT NULL,
	CONSTRAINT "purchase_order_line_qty_positive" CHECK ("app"."purchase_order_line"."qty_ordered" > 0)
);
--> statement-breakpoint
CREATE TABLE "app"."supplier_invoice" (
	"id" uuid PRIMARY KEY NOT NULL,
	"supplier_id" uuid NOT NULL,
	"piece_ref" text NOT NULL,
	"date" date NOT NULL,
	"due_date" date NOT NULL,
	"total_excl" numeric(12, 2) NOT NULL,
	"total_vat" numeric(12, 2) DEFAULT '0' NOT NULL,
	"total_incl" numeric(12, 2) NOT NULL,
	"status" "app"."supplier_invoice_status" DEFAULT 'TO_PAY' NOT NULL,
	"payment_method" "app"."supplier_payment_method",
	"paid_at" date,
	"document_media_id" uuid,
	"comment" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"legacy_factid" integer,
	CONSTRAINT "supplier_invoice_legacy_factid_unique" UNIQUE("legacy_factid"),
	CONSTRAINT "supplier_invoice_due_after_date" CHECK ("app"."supplier_invoice"."due_date" >= "app"."supplier_invoice"."date"),
	CONSTRAINT "supplier_invoice_totals" CHECK ("app"."supplier_invoice"."total_incl" = "app"."supplier_invoice"."total_excl" + "app"."supplier_invoice"."total_vat")
);
--> statement-breakpoint
ALTER TABLE "app"."supplier" ADD COLUMN "min_order_amount" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "app"."supplier" ADD COLUMN "payment_terms_days" integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."supplier" ADD COLUMN "delivery_day" text;--> statement-breakpoint
ALTER TABLE "app"."goods_receipt" ADD CONSTRAINT "goods_receipt_order_id_purchase_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "app"."purchase_order"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."goods_receipt" ADD CONSTRAINT "goods_receipt_supplier_id_supplier_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "app"."supplier"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."goods_receipt" ADD CONSTRAINT "goods_receipt_received_by_member_id_fk" FOREIGN KEY ("received_by") REFERENCES "app"."member"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."goods_receipt_line" ADD CONSTRAINT "goods_receipt_line_receipt_id_goods_receipt_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "app"."goods_receipt"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."goods_receipt_line" ADD CONSTRAINT "goods_receipt_line_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "app"."product"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."goods_receipt_line" ADD CONSTRAINT "goods_receipt_line_order_line_id_purchase_order_line_id_fk" FOREIGN KEY ("order_line_id") REFERENCES "app"."purchase_order_line"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."inventory_line" ADD CONSTRAINT "inventory_line_session_id_inventory_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "app"."inventory_session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."inventory_line" ADD CONSTRAINT "inventory_line_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "app"."product"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."inventory_line" ADD CONSTRAINT "inventory_line_counted_by_member_id_fk" FOREIGN KEY ("counted_by") REFERENCES "app"."member"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."inventory_session" ADD CONSTRAINT "inventory_session_opened_by_member_id_fk" FOREIGN KEY ("opened_by") REFERENCES "app"."member"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."inventory_session" ADD CONSTRAINT "inventory_session_validated_by_member_id_fk" FOREIGN KEY ("validated_by") REFERENCES "app"."member"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."invoice_receipt" ADD CONSTRAINT "invoice_receipt_invoice_id_supplier_invoice_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "app"."supplier_invoice"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."invoice_receipt" ADD CONSTRAINT "invoice_receipt_receipt_id_goods_receipt_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "app"."goods_receipt"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."purchase_order" ADD CONSTRAINT "purchase_order_supplier_id_supplier_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "app"."supplier"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."purchase_order" ADD CONSTRAINT "purchase_order_created_by_member_id_fk" FOREIGN KEY ("created_by") REFERENCES "app"."member"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."purchase_order_line" ADD CONSTRAINT "purchase_order_line_order_id_purchase_order_id_fk" FOREIGN KEY ("order_id") REFERENCES "app"."purchase_order"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."purchase_order_line" ADD CONSTRAINT "purchase_order_line_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "app"."product"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."supplier_invoice" ADD CONSTRAINT "supplier_invoice_supplier_id_supplier_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "app"."supplier"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."supplier_invoice" ADD CONSTRAINT "supplier_invoice_document_media_id_media_id_fk" FOREIGN KEY ("document_media_id") REFERENCES "app"."media"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."supplier_invoice" ADD CONSTRAINT "supplier_invoice_created_by_member_id_fk" FOREIGN KEY ("created_by") REFERENCES "app"."member"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "goods_receipt_supplier_idx" ON "app"."goods_receipt" USING btree ("supplier_id","date");--> statement-breakpoint
CREATE INDEX "goods_receipt_order_idx" ON "app"."goods_receipt" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "goods_receipt_line_receipt_idx" ON "app"."goods_receipt_line" USING btree ("receipt_id");--> statement-breakpoint
CREATE INDEX "purchase_order_supplier_idx" ON "app"."purchase_order" USING btree ("supplier_id","date");--> statement-breakpoint
CREATE INDEX "purchase_order_status_idx" ON "app"."purchase_order" USING btree ("status");--> statement-breakpoint
CREATE INDEX "purchase_order_line_order_idx" ON "app"."purchase_order_line" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_invoice_piece_uq" ON "app"."supplier_invoice" USING btree ("supplier_id","piece_ref");--> statement-breakpoint
CREATE INDEX "supplier_invoice_due_idx" ON "app"."supplier_invoice" USING btree ("status","due_date");