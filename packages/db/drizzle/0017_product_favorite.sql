CREATE TABLE "app"."product_favorite" (
	"member_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_favorite_member_id_product_id_pk" PRIMARY KEY("member_id","product_id")
);
--> statement-breakpoint
ALTER TABLE "app"."product_favorite" ADD CONSTRAINT "product_favorite_member_id_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "app"."member"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."product_favorite" ADD CONSTRAINT "product_favorite_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "app"."product"("id") ON DELETE cascade ON UPDATE no action;