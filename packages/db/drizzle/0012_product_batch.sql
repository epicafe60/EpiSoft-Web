CREATE TABLE "app"."product_batch" (
	"id" uuid PRIMARY KEY NOT NULL,
	"product_id" uuid NOT NULL,
	"best_before" date NOT NULL,
	"qty" numeric(12, 3) NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"by" uuid,
	CONSTRAINT "product_batch_qty" CHECK ("app"."product_batch"."qty" > 0)
);
--> statement-breakpoint
ALTER TABLE "app"."product_batch" ADD CONSTRAINT "product_batch_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "app"."product"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."product_batch" ADD CONSTRAINT "product_batch_by_member_id_fk" FOREIGN KEY ("by") REFERENCES "app"."member"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "product_batch_date_idx" ON "app"."product_batch" USING btree ("best_before");