CREATE TABLE "app"."consent" (
	"id" uuid PRIMARY KEY NOT NULL,
	"member_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"granted" boolean NOT NULL,
	"text_version" text NOT NULL,
	"channel" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"recorded_by" uuid
);
--> statement-breakpoint
CREATE TABLE "app"."product_lot" (
	"id" uuid PRIMARY KEY NOT NULL,
	"product_id" uuid NOT NULL,
	"supplier_id" uuid,
	"receipt_id" uuid,
	"receipt_line_id" uuid,
	"lot_number" text NOT NULL,
	"best_before" date,
	"qty" numeric(12, 3) NOT NULL,
	"received_on" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"by" uuid,
	CONSTRAINT "product_lot_qty" CHECK ("app"."product_lot"."qty" > 0)
);
--> statement-breakpoint
ALTER TABLE "app"."product" ADD COLUMN "is_food" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."product" ADD COLUMN "ingredients" text;--> statement-breakpoint
ALTER TABLE "app"."product" ADD COLUMN "allergens_decision" text;--> statement-breakpoint
ALTER TABLE "app"."product" ADD COLUMN "allergens" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."product" ADD COLUMN "allergen_traces" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."product" ADD COLUMN "origin" text;--> statement-breakpoint
ALTER TABLE "app"."product" ADD COLUMN "origin_family" text;--> statement-breakpoint
ALTER TABLE "app"."product" ADD COLUMN "local_justification" text;--> statement-breakpoint
ALTER TABLE "app"."supplier" ADD COLUMN "organic_cert_number" text;--> statement-breakpoint
ALTER TABLE "app"."supplier" ADD COLUMN "organic_cert_body" text;--> statement-breakpoint
ALTER TABLE "app"."supplier" ADD COLUMN "organic_cert_expiry" date;--> statement-breakpoint
ALTER TABLE "app"."consent" ADD CONSTRAINT "consent_member_id_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "app"."member"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."consent" ADD CONSTRAINT "consent_recorded_by_member_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "app"."member"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."product_lot" ADD CONSTRAINT "product_lot_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "app"."product"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."product_lot" ADD CONSTRAINT "product_lot_supplier_id_supplier_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "app"."supplier"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."product_lot" ADD CONSTRAINT "product_lot_receipt_id_goods_receipt_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "app"."goods_receipt"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."product_lot" ADD CONSTRAINT "product_lot_receipt_line_id_goods_receipt_line_id_fk" FOREIGN KEY ("receipt_line_id") REFERENCES "app"."goods_receipt_line"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."product_lot" ADD CONSTRAINT "product_lot_by_member_id_fk" FOREIGN KEY ("by") REFERENCES "app"."member"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "consent_member_idx" ON "app"."consent" USING btree ("member_id","purpose","at");--> statement-breakpoint
CREATE INDEX "product_lot_product_idx" ON "app"."product_lot" USING btree ("product_id","received_on");--> statement-breakpoint
CREATE INDEX "product_lot_number_idx" ON "app"."product_lot" USING btree ("lot_number");