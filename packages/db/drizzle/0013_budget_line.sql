CREATE TABLE "app"."budget_line" (
	"id" uuid PRIMARY KEY NOT NULL,
	"fiscal_year_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "budget_line_amount" CHECK ("app"."budget_line"."amount" >= 0)
);
--> statement-breakpoint
ALTER TABLE "app"."budget_line" ADD CONSTRAINT "budget_line_fiscal_year_id_fiscal_year_id_fk" FOREIGN KEY ("fiscal_year_id") REFERENCES "app"."fiscal_year"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."budget_line" ADD CONSTRAINT "budget_line_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "app"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "budget_line_uq" ON "app"."budget_line" USING btree ("fiscal_year_id","account_id");