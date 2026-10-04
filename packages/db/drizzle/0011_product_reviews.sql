CREATE TABLE "app"."product_review" (
	"id" uuid PRIMARY KEY NOT NULL,
	"product_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"rating" integer NOT NULL,
	"comment" text,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_review_rating" CHECK ("app"."product_review"."rating" between 1 and 5)
);
--> statement-breakpoint
ALTER TABLE "app"."product_review" ADD CONSTRAINT "product_review_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "app"."product"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."product_review" ADD CONSTRAINT "product_review_member_id_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "app"."member"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "product_review_uq" ON "app"."product_review" USING btree ("product_id","member_id");--> statement-breakpoint
CREATE INDEX "product_review_status_idx" ON "app"."product_review" USING btree ("status","created_at");