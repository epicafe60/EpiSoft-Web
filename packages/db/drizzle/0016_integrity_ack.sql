CREATE TABLE "app"."integrity_ack" (
	"check_id" text NOT NULL,
	"ref" text NOT NULL,
	"note" text,
	"by" uuid,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integrity_ack_check_id_ref_pk" PRIMARY KEY("check_id","ref")
);
--> statement-breakpoint
ALTER TABLE "app"."integrity_ack" ADD CONSTRAINT "integrity_ack_by_member_id_fk" FOREIGN KEY ("by") REFERENCES "app"."member"("id") ON DELETE set null ON UPDATE no action;