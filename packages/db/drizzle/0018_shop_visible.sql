ALTER TABLE "app"."category" ADD COLUMN "shop_visible" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."product" ADD COLUMN "shop_visible" boolean DEFAULT true NOT NULL;