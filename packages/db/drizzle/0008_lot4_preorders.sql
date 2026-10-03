CREATE TYPE "app"."preorder_status" AS ENUM('SUBMITTED', 'READY', 'PICKED_UP', 'CANCELLED');--> statement-breakpoint
CREATE TABLE "app"."preorder" (
	"id" uuid PRIMARY KEY NOT NULL,
	"number" text NOT NULL,
	"member_id" uuid NOT NULL,
	"household_id" uuid,
	"status" "app"."preorder_status" DEFAULT 'SUBMITTED' NOT NULL,
	"pickup_date" date NOT NULL,
	"comment" text,
	"sale_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "preorder_number_unique" UNIQUE("number")
);
--> statement-breakpoint
CREATE TABLE "app"."preorder_line" (
	"id" uuid PRIMARY KEY NOT NULL,
	"preorder_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"product_id" uuid NOT NULL,
	"label" text NOT NULL,
	"qty" numeric(12, 3) NOT NULL,
	"unit_price" numeric(12, 2) NOT NULL,
	CONSTRAINT "preorder_line_qty_positive" CHECK ("app"."preorder_line"."qty" > 0)
);
--> statement-breakpoint
ALTER TABLE "app"."preorder" ADD CONSTRAINT "preorder_member_id_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "app"."member"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."preorder" ADD CONSTRAINT "preorder_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "app"."household"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."preorder" ADD CONSTRAINT "preorder_sale_id_sale_id_fk" FOREIGN KEY ("sale_id") REFERENCES "app"."sale"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."preorder" ADD CONSTRAINT "preorder_created_by_member_id_fk" FOREIGN KEY ("created_by") REFERENCES "app"."member"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."preorder_line" ADD CONSTRAINT "preorder_line_preorder_id_preorder_id_fk" FOREIGN KEY ("preorder_id") REFERENCES "app"."preorder"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."preorder_line" ADD CONSTRAINT "preorder_line_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "app"."product"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "preorder_member_idx" ON "app"."preorder" USING btree ("member_id","created_at");--> statement-breakpoint
CREATE INDEX "preorder_status_idx" ON "app"."preorder" USING btree ("status","pickup_date");--> statement-breakpoint
CREATE INDEX "preorder_line_order_idx" ON "app"."preorder_line" USING btree ("preorder_id");--> statement-breakpoint
CREATE INDEX "preorder_line_product_idx" ON "app"."preorder_line" USING btree ("product_id");