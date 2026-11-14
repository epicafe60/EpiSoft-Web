CREATE TYPE "app"."feedback_kind" AS ENUM('BUG', 'EVOLUTION');--> statement-breakpoint
CREATE TYPE "app"."feedback_priority" AS ENUM('LOW', 'NORMAL', 'HIGH');--> statement-breakpoint
CREATE TYPE "app"."feedback_status" AS ENUM('NEW', 'ACCEPTED', 'IN_PROGRESS', 'TO_TEST', 'DONE', 'REFUSED', 'DUPLICATE');--> statement-breakpoint
CREATE TABLE "app"."feedback_comment" (
	"id" uuid PRIMARY KEY NOT NULL,
	"ticket_id" uuid NOT NULL,
	"author_id" uuid,
	"from_team" boolean DEFAULT false NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."feedback_ticket" (
	"id" uuid PRIMARY KEY NOT NULL,
	"number" integer NOT NULL,
	"kind" "app"."feedback_kind" NOT NULL,
	"module" text NOT NULL,
	"screen" text DEFAULT '' NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"steps" text DEFAULT '' NOT NULL,
	"status" "app"."feedback_status" DEFAULT 'NEW' NOT NULL,
	"priority" "app"."feedback_priority" DEFAULT 'NORMAL' NOT NULL,
	"author_id" uuid,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "feedback_ticket_number_unique" UNIQUE("number")
);
--> statement-breakpoint
ALTER TABLE "app"."feedback_comment" ADD CONSTRAINT "feedback_comment_ticket_id_feedback_ticket_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "app"."feedback_ticket"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."feedback_comment" ADD CONSTRAINT "feedback_comment_author_id_member_id_fk" FOREIGN KEY ("author_id") REFERENCES "app"."member"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."feedback_ticket" ADD CONSTRAINT "feedback_ticket_author_id_member_id_fk" FOREIGN KEY ("author_id") REFERENCES "app"."member"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "feedback_comment_ticket_idx" ON "app"."feedback_comment" USING btree ("ticket_id","created_at");--> statement-breakpoint
CREATE INDEX "feedback_ticket_status_idx" ON "app"."feedback_ticket" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "feedback_ticket_author_idx" ON "app"."feedback_ticket" USING btree ("author_id","created_at");--> statement-breakpoint
SELECT app.attach_change_capture();
