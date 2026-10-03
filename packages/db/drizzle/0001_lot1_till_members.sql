CREATE TYPE "app"."cash_session_status" AS ENUM('OPEN', 'CLOSED');--> statement-breakpoint
CREATE TYPE "app"."member_payment_purpose" AS ENUM('MEMBERSHIP', 'TOPUP', 'DONATION', 'OTHER');--> statement-breakpoint
CREATE TYPE "app"."payment_method" AS ENUM('CASH', 'CHEQUE', 'CARD', 'WALLET', 'TRANSFER');--> statement-breakpoint
CREATE TYPE "app"."price_source" AS ENUM('FORM', 'RECEIPT', 'IMPORT', 'BULK', 'MIGRATION');--> statement-breakpoint
CREATE TYPE "app"."product_kind" AS ENUM('GOODS', 'SERVICE');--> statement-breakpoint
CREATE TYPE "app"."product_status" AS ENUM('ON_ORDER', 'ACTIVE', 'INACTIVE', 'UNAVAILABLE');--> statement-breakpoint
CREATE TYPE "app"."sale_condition" AS ENUM('ON_SITE', 'ON_ORDER', 'BOTH');--> statement-breakpoint
CREATE TYPE "app"."sale_mode" AS ENUM('UNIT', 'WEIGHT', 'VOLUME');--> statement-breakpoint
CREATE TYPE "app"."sale_status" AS ENUM('COMPLETED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "app"."stock_movement_kind" AS ENUM('SALE', 'SALE_CANCEL', 'PURCHASE_IN', 'SUPPLIER_RETURN', 'INVENTORY', 'LOSS', 'CORRECTION', 'INITIAL');--> statement-breakpoint
CREATE TYPE "app"."unit" AS ENUM('G', 'KG', 'ML', 'L');--> statement-breakpoint
CREATE TYPE "app"."wallet_entry_kind" AS ENUM('TOPUP', 'PURCHASE', 'REFUND', 'CORRECTION');--> statement-breakpoint
CREATE TABLE "app"."cash_count" (
	"session_id" uuid PRIMARY KEY NOT NULL,
	"denominations" jsonb NOT NULL,
	"counted_cash" numeric(12, 2) NOT NULL,
	"expected_cash" numeric(12, 2) NOT NULL,
	"difference" numeric(12, 2) NOT NULL,
	"bank_deposit" numeric(12, 2) NOT NULL,
	"next_float" numeric(12, 2) NOT NULL,
	"cheques_count" integer DEFAULT 0 NOT NULL,
	"cheques_total" numeric(12, 2) DEFAULT '0' NOT NULL,
	"card_total_declared" numeric(12, 2) DEFAULT '0' NOT NULL,
	"summary" jsonb NOT NULL,
	"comment" text
);
--> statement-breakpoint
CREATE TABLE "app"."cash_session" (
	"id" uuid PRIMARY KEY NOT NULL,
	"device_id" uuid NOT NULL,
	"opened_by" uuid,
	"opened_at" timestamp with time zone NOT NULL,
	"opening_float" numeric(12, 2) NOT NULL,
	"closed_by" uuid,
	"closed_at" timestamp with time zone,
	"status" "app"."cash_session_status" DEFAULT 'OPEN' NOT NULL,
	"legacy_date" date,
	CONSTRAINT "cash_session_legacy_date_unique" UNIQUE("legacy_date")
);
--> statement-breakpoint
CREATE TABLE "app"."category" (
	"id" uuid PRIMARY KEY NOT NULL,
	"universe_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."media" (
	"id" uuid PRIMARY KEY NOT NULL,
	"mime" text NOT NULL,
	"bytes" "bytea" NOT NULL,
	"width" integer,
	"height" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."member_payment" (
	"id" uuid PRIMARY KEY NOT NULL,
	"household_id" uuid NOT NULL,
	"date" date NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"purpose" "app"."member_payment_purpose" NOT NULL,
	"method" "app"."payment_method",
	"cash_session_id" uuid,
	"sale_id" uuid,
	"comment" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"legacy_payid" integer,
	CONSTRAINT "member_payment_legacy_payid_unique" UNIQUE("legacy_payid"),
	CONSTRAINT "member_payment_not_wallet" CHECK ("app"."member_payment"."method" is distinct from 'WALLET')
);
--> statement-breakpoint
CREATE TABLE "app"."membership" (
	"id" uuid PRIMARY KEY NOT NULL,
	"household_id" uuid NOT NULL,
	"type_id" uuid NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"sale_id" uuid,
	"payment_id" uuid,
	"cancelled_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"legacy_adhid" integer,
	CONSTRAINT "membership_legacy_adhid_unique" UNIQUE("legacy_adhid"),
	CONSTRAINT "membership_dates" CHECK ("app"."membership"."end_date" >= "app"."membership"."start_date")
);
--> statement-breakpoint
CREATE TABLE "app"."membership_type" (
	"id" uuid PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"label" text NOT NULL,
	"price" numeric(12, 2) NOT NULL,
	"duration_months" integer NOT NULL,
	"product_id" uuid,
	"active" boolean DEFAULT true NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "membership_type_code_unique" UNIQUE("code"),
	CONSTRAINT "membership_type_product_id_unique" UNIQUE("product_id")
);
--> statement-breakpoint
CREATE TABLE "app"."number_counter" (
	"key" text PRIMARY KEY NOT NULL,
	"value" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."pos_device" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"last_sync_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pos_device_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "app"."pos_tab" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"legacy_tabid" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pos_tab_legacy_tabid_unique" UNIQUE("legacy_tabid")
);
--> statement-breakpoint
CREATE TABLE "app"."price_history" (
	"id" uuid PRIMARY KEY NOT NULL,
	"product_id" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"purchase_price_excl" numeric(12, 4),
	"purchase_price_incl" numeric(12, 4),
	"sale_price" numeric(12, 2) NOT NULL,
	"source" "app"."price_source" NOT NULL,
	"by" uuid
);
--> statement-breakpoint
CREATE TABLE "app"."product" (
	"id" uuid PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"kind" "app"."product_kind" DEFAULT 'GOODS' NOT NULL,
	"sale_mode" "app"."sale_mode" DEFAULT 'UNIT' NOT NULL,
	"unit_qty" numeric(12, 3),
	"unit" "app"."unit",
	"sale_condition" "app"."sale_condition" DEFAULT 'ON_SITE' NOT NULL,
	"category_id" uuid,
	"supplier_id" uuid,
	"supplier_ref" text,
	"qualities" text[] DEFAULT '{}'::text[] NOT NULL,
	"vat_rate" numeric(5, 2) DEFAULT '0' NOT NULL,
	"status" "app"."product_status" DEFAULT 'ACTIVE' NOT NULL,
	"purchase_price_excl" numeric(12, 4),
	"purchase_price_incl" numeric(12, 4),
	"sale_price" numeric(12, 2) DEFAULT '0' NOT NULL,
	"min_stock" numeric(12, 3),
	"stock_qty" numeric(12, 3) DEFAULT '0' NOT NULL,
	"label_pending" boolean DEFAULT false NOT NULL,
	"pos_tab_id" uuid,
	"pos_sort" integer DEFAULT 0 NOT NULL,
	"pos_label" text,
	"image_id" uuid,
	"created_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_code_unique" UNIQUE("code"),
	CONSTRAINT "product_sale_price_positive" CHECK ("app"."product"."sale_price" >= 0)
);
--> statement-breakpoint
CREATE TABLE "app"."product_barcode" (
	"ean" text PRIMARY KEY NOT NULL,
	"product_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."sale" (
	"id" uuid PRIMARY KEY NOT NULL,
	"number" text NOT NULL,
	"provisional_number" text,
	"device_seq" integer,
	"device_id" uuid,
	"session_id" uuid NOT NULL,
	"cashier_id" uuid,
	"member_id" uuid,
	"household_id" uuid,
	"sold_at" timestamp with time zone NOT NULL,
	"total" numeric(12, 2) NOT NULL,
	"discount_total" numeric(12, 2) DEFAULT '0' NOT NULL,
	"status" "app"."sale_status" DEFAULT 'COMPLETED' NOT NULL,
	"cancels_sale_id" uuid,
	"has_services" boolean DEFAULT false NOT NULL,
	"email_sent_at" timestamp with time zone,
	"warnings" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"legacy_ref" text,
	CONSTRAINT "sale_number_unique" UNIQUE("number"),
	CONSTRAINT "sale_legacy_ref_unique" UNIQUE("legacy_ref")
);
--> statement-breakpoint
CREATE TABLE "app"."sale_line" (
	"id" uuid PRIMARY KEY NOT NULL,
	"sale_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"product_id" uuid NOT NULL,
	"label" text NOT NULL,
	"qty" numeric(12, 3) NOT NULL,
	"unit_price" numeric(12, 4) NOT NULL,
	"catalog_price" numeric(12, 4),
	"discount" numeric(12, 2) DEFAULT '0' NOT NULL,
	"line_total" numeric(12, 2) NOT NULL,
	"vat_rate" numeric(5, 2) DEFAULT '0' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."sale_payment" (
	"id" uuid PRIMARY KEY NOT NULL,
	"sale_id" uuid NOT NULL,
	"method" "app"."payment_method" NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"tendered" numeric(12, 2),
	"change" numeric(12, 2),
	"change_to_wallet" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."stock_movement" (
	"id" uuid PRIMARY KEY NOT NULL,
	"product_id" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"qty" numeric(12, 3) NOT NULL,
	"kind" "app"."stock_movement_kind" NOT NULL,
	"unit_cost" numeric(12, 4),
	"source_type" text,
	"source_id" text,
	"comment" text,
	"by" uuid
);
--> statement-breakpoint
CREATE TABLE "app"."supplier" (
	"id" uuid PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"contact" text,
	"street" text,
	"postcode" text,
	"commune_id" uuid,
	"phone" text,
	"email" text,
	"website" text,
	"price_list_url" text,
	"active" boolean DEFAULT true NOT NULL,
	"public_notes" text,
	"private_notes" text,
	"referent_member_id" uuid,
	"sends_po" boolean DEFAULT false NOT NULL,
	"account_number" text,
	"legacy_fnrcode" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "supplier_code_unique" UNIQUE("code"),
	CONSTRAINT "supplier_legacy_fnrcode_unique" UNIQUE("legacy_fnrcode")
);
--> statement-breakpoint
CREATE TABLE "app"."sync_receipt" (
	"client_id" uuid PRIMARY KEY NOT NULL,
	"device_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"result" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."universe" (
	"id" uuid PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "universe_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "app"."wallet_entry" (
	"id" uuid PRIMARY KEY NOT NULL,
	"household_id" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"kind" "app"."wallet_entry_kind" NOT NULL,
	"payment_method" "app"."payment_method",
	"sale_id" uuid,
	"payment_id" uuid,
	"comment" text,
	"forced_by" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"legacy_payid" integer,
	CONSTRAINT "wallet_entry_legacy_payid_unique" UNIQUE("legacy_payid"),
	CONSTRAINT "wallet_entry_amount_not_zero" CHECK ("app"."wallet_entry"."amount" <> 0),
	CONSTRAINT "wallet_entry_sign" CHECK (("app"."wallet_entry"."kind" in ('TOPUP', 'REFUND') and "app"."wallet_entry"."amount" > 0) or ("app"."wallet_entry"."kind" = 'PURCHASE' and "app"."wallet_entry"."amount" < 0) or "app"."wallet_entry"."kind" = 'CORRECTION')
);
--> statement-breakpoint
ALTER TABLE "app"."cash_count" ADD CONSTRAINT "cash_count_session_id_cash_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "app"."cash_session"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."cash_session" ADD CONSTRAINT "cash_session_device_id_pos_device_id_fk" FOREIGN KEY ("device_id") REFERENCES "app"."pos_device"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."cash_session" ADD CONSTRAINT "cash_session_opened_by_member_id_fk" FOREIGN KEY ("opened_by") REFERENCES "app"."member"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."cash_session" ADD CONSTRAINT "cash_session_closed_by_member_id_fk" FOREIGN KEY ("closed_by") REFERENCES "app"."member"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."category" ADD CONSTRAINT "category_universe_id_universe_id_fk" FOREIGN KEY ("universe_id") REFERENCES "app"."universe"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."member_payment" ADD CONSTRAINT "member_payment_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "app"."household"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."member_payment" ADD CONSTRAINT "member_payment_cash_session_id_cash_session_id_fk" FOREIGN KEY ("cash_session_id") REFERENCES "app"."cash_session"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."member_payment" ADD CONSTRAINT "member_payment_sale_id_sale_id_fk" FOREIGN KEY ("sale_id") REFERENCES "app"."sale"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."member_payment" ADD CONSTRAINT "member_payment_created_by_member_id_fk" FOREIGN KEY ("created_by") REFERENCES "app"."member"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."membership" ADD CONSTRAINT "membership_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "app"."household"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."membership" ADD CONSTRAINT "membership_type_id_membership_type_id_fk" FOREIGN KEY ("type_id") REFERENCES "app"."membership_type"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."membership" ADD CONSTRAINT "membership_sale_id_sale_id_fk" FOREIGN KEY ("sale_id") REFERENCES "app"."sale"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."membership" ADD CONSTRAINT "membership_payment_id_member_payment_id_fk" FOREIGN KEY ("payment_id") REFERENCES "app"."member_payment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."membership" ADD CONSTRAINT "membership_created_by_member_id_fk" FOREIGN KEY ("created_by") REFERENCES "app"."member"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."membership_type" ADD CONSTRAINT "membership_type_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "app"."product"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."pos_device" ADD CONSTRAINT "pos_device_created_by_member_id_fk" FOREIGN KEY ("created_by") REFERENCES "app"."member"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."price_history" ADD CONSTRAINT "price_history_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "app"."product"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."price_history" ADD CONSTRAINT "price_history_by_member_id_fk" FOREIGN KEY ("by") REFERENCES "app"."member"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."product" ADD CONSTRAINT "product_category_id_category_id_fk" FOREIGN KEY ("category_id") REFERENCES "app"."category"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."product" ADD CONSTRAINT "product_supplier_id_supplier_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "app"."supplier"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."product" ADD CONSTRAINT "product_pos_tab_id_pos_tab_id_fk" FOREIGN KEY ("pos_tab_id") REFERENCES "app"."pos_tab"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."product" ADD CONSTRAINT "product_image_id_media_id_fk" FOREIGN KEY ("image_id") REFERENCES "app"."media"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."product_barcode" ADD CONSTRAINT "product_barcode_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "app"."product"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."sale" ADD CONSTRAINT "sale_device_id_pos_device_id_fk" FOREIGN KEY ("device_id") REFERENCES "app"."pos_device"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."sale" ADD CONSTRAINT "sale_session_id_cash_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "app"."cash_session"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."sale" ADD CONSTRAINT "sale_cashier_id_member_id_fk" FOREIGN KEY ("cashier_id") REFERENCES "app"."member"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."sale" ADD CONSTRAINT "sale_member_id_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "app"."member"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."sale" ADD CONSTRAINT "sale_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "app"."household"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."sale" ADD CONSTRAINT "sale_cancels_sale_id_sale_id_fk" FOREIGN KEY ("cancels_sale_id") REFERENCES "app"."sale"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."sale_line" ADD CONSTRAINT "sale_line_sale_id_sale_id_fk" FOREIGN KEY ("sale_id") REFERENCES "app"."sale"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."sale_line" ADD CONSTRAINT "sale_line_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "app"."product"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."sale_payment" ADD CONSTRAINT "sale_payment_sale_id_sale_id_fk" FOREIGN KEY ("sale_id") REFERENCES "app"."sale"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."stock_movement" ADD CONSTRAINT "stock_movement_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "app"."product"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."stock_movement" ADD CONSTRAINT "stock_movement_by_member_id_fk" FOREIGN KEY ("by") REFERENCES "app"."member"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."supplier" ADD CONSTRAINT "supplier_commune_id_commune_id_fk" FOREIGN KEY ("commune_id") REFERENCES "app"."commune"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."supplier" ADD CONSTRAINT "supplier_referent_member_id_member_id_fk" FOREIGN KEY ("referent_member_id") REFERENCES "app"."member"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."sync_receipt" ADD CONSTRAINT "sync_receipt_device_id_pos_device_id_fk" FOREIGN KEY ("device_id") REFERENCES "app"."pos_device"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."wallet_entry" ADD CONSTRAINT "wallet_entry_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "app"."household"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."wallet_entry" ADD CONSTRAINT "wallet_entry_sale_id_sale_id_fk" FOREIGN KEY ("sale_id") REFERENCES "app"."sale"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."wallet_entry" ADD CONSTRAINT "wallet_entry_payment_id_member_payment_id_fk" FOREIGN KEY ("payment_id") REFERENCES "app"."member_payment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."wallet_entry" ADD CONSTRAINT "wallet_entry_forced_by_member_id_fk" FOREIGN KEY ("forced_by") REFERENCES "app"."member"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."wallet_entry" ADD CONSTRAINT "wallet_entry_created_by_member_id_fk" FOREIGN KEY ("created_by") REFERENCES "app"."member"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cash_session_one_open_per_device" ON "app"."cash_session" USING btree ("device_id") WHERE "app"."cash_session"."status" = 'OPEN';--> statement-breakpoint
CREATE INDEX "cash_session_opened_idx" ON "app"."cash_session" USING btree ("opened_at");--> statement-breakpoint
CREATE UNIQUE INDEX "category_universe_code_uq" ON "app"."category" USING btree ("universe_id","code");--> statement-breakpoint
CREATE INDEX "member_payment_household_idx" ON "app"."member_payment" USING btree ("household_id","date");--> statement-breakpoint
CREATE INDEX "member_payment_session_idx" ON "app"."member_payment" USING btree ("cash_session_id");--> statement-breakpoint
CREATE INDEX "membership_household_idx" ON "app"."membership" USING btree ("household_id","end_date");--> statement-breakpoint
CREATE INDEX "price_history_product_idx" ON "app"."price_history" USING btree ("product_id","at");--> statement-breakpoint
CREATE INDEX "product_name_idx" ON "app"."product" USING btree ("name");--> statement-breakpoint
CREATE INDEX "product_updated_idx" ON "app"."product" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "product_barcode_product_idx" ON "app"."product_barcode" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "sale_session_idx" ON "app"."sale" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "sale_household_idx" ON "app"."sale" USING btree ("household_id","sold_at");--> statement-breakpoint
CREATE INDEX "sale_member_idx" ON "app"."sale" USING btree ("member_id","sold_at");--> statement-breakpoint
CREATE INDEX "sale_sold_at_idx" ON "app"."sale" USING btree ("sold_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sale_one_cancellation" ON "app"."sale" USING btree ("cancels_sale_id") WHERE "app"."sale"."cancels_sale_id" is not null;--> statement-breakpoint
CREATE INDEX "sale_line_sale_idx" ON "app"."sale_line" USING btree ("sale_id");--> statement-breakpoint
CREATE INDEX "sale_line_product_idx" ON "app"."sale_line" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "sale_payment_sale_idx" ON "app"."sale_payment" USING btree ("sale_id");--> statement-breakpoint
CREATE INDEX "stock_movement_product_at_idx" ON "app"."stock_movement" USING btree ("product_id","at");--> statement-breakpoint
CREATE INDEX "stock_movement_source_idx" ON "app"."stock_movement" USING btree ("source_type","source_id");--> statement-breakpoint
CREATE INDEX "wallet_entry_household_idx" ON "app"."wallet_entry" USING btree ("household_id","at");--> statement-breakpoint
CREATE INDEX "wallet_entry_created_idx" ON "app"."wallet_entry" USING btree ("created_at");