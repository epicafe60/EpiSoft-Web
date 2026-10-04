CREATE TABLE "app"."push_subscription" (
	"id" uuid PRIMARY KEY NOT NULL,
	"member_id" uuid NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "push_subscription_endpoint_unique" UNIQUE("endpoint")
);
--> statement-breakpoint
ALTER TABLE "app"."push_subscription" ADD CONSTRAINT "push_subscription_member_id_member_id_fk" FOREIGN KEY ("member_id") REFERENCES "app"."member"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "push_subscription_member_idx" ON "app"."push_subscription" USING btree ("member_id");