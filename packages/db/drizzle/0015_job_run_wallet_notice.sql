CREATE TABLE "app"."job_run" (
	"name" text NOT NULL,
	"day" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_run_name_day_pk" PRIMARY KEY("name","day")
);
--> statement-breakpoint
CREATE TABLE "app"."wallet_low_notice" (
	"household_id" uuid PRIMARY KEY NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."wallet_low_notice" ADD CONSTRAINT "wallet_low_notice_household_id_household_id_fk" FOREIGN KEY ("household_id") REFERENCES "app"."household"("id") ON DELETE cascade ON UPDATE no action;