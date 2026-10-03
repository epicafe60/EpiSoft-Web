CREATE TYPE "app"."bank_line_status" AS ENUM('NEW', 'MATCHED');--> statement-breakpoint
CREATE TYPE "app"."bank_rule_direction" AS ENUM('IN', 'OUT', 'ANY');--> statement-breakpoint
CREATE TYPE "app"."bank_rule_match" AS ENUM('CONTAINS', 'STARTS', 'REGEX');--> statement-breakpoint
CREATE TYPE "app"."deposit_kind" AS ENUM('CASH', 'CHEQUES');--> statement-breakpoint
CREATE TYPE "app"."entry_mode" AS ENUM('CASH', 'CHEQUE', 'CARD', 'TRANSFER', 'DIRECT_DEBIT', 'OTHER');--> statement-breakpoint
CREATE TYPE "app"."entry_status" AS ENUM('DRAFT', 'VALIDATED');--> statement-breakpoint
CREATE TYPE "app"."fiscal_year_status" AS ENUM('OPEN', 'CLOSED');--> statement-breakpoint
CREATE TYPE "app"."normal_side" AS ENUM('D', 'C', 'M');--> statement-breakpoint
CREATE TYPE "app"."statement_status" AS ENUM('OPEN', 'CLOSED');--> statement-breakpoint
CREATE TABLE "app"."account" (
	"id" uuid PRIMARY KEY NOT NULL,
	"number" text NOT NULL,
	"label" text NOT NULL,
	"normal_side" "app"."normal_side" DEFAULT 'D' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_number_unique" UNIQUE("number"),
	CONSTRAINT "account_number_six_digits" CHECK ("app"."account"."number" ~ '^[0-9]{6}$')
);
--> statement-breakpoint
CREATE TABLE "app"."bank_account" (
	"id" uuid PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"iban" text,
	"account_id" uuid NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."bank_line" (
	"id" uuid PRIMARY KEY NOT NULL,
	"statement_id" uuid NOT NULL,
	"bank_account_id" uuid NOT NULL,
	"fitid" text,
	"fingerprint" text NOT NULL,
	"date" date NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"label" text NOT NULL,
	"memo" text,
	"status" "app"."bank_line_status" DEFAULT 'NEW' NOT NULL,
	"entry_line_id" uuid,
	"rule_id" uuid
);
--> statement-breakpoint
CREATE TABLE "app"."bank_rule" (
	"id" uuid PRIMARY KEY NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"label" text NOT NULL,
	"pattern" text NOT NULL,
	"match_type" "app"."bank_rule_match" DEFAULT 'CONTAINS' NOT NULL,
	"direction" "app"."bank_rule_direction" DEFAULT 'ANY' NOT NULL,
	"min_amount" numeric(12, 2),
	"max_amount" numeric(12, 2),
	"counter_account_id" uuid,
	"journal_id" uuid,
	"mode" "app"."entry_mode",
	"label_template" text,
	"household_match" boolean DEFAULT false NOT NULL,
	"supplier_id" uuid,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."bank_statement" (
	"id" uuid PRIMARY KEY NOT NULL,
	"bank_account_id" uuid NOT NULL,
	"file_name" text NOT NULL,
	"file_hash" text NOT NULL,
	"format" text NOT NULL,
	"period_start" date,
	"period_end" date,
	"opening_balance" numeric(12, 2) NOT NULL,
	"closing_balance" numeric(12, 2) NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"imported_by" uuid,
	"status" "app"."statement_status" DEFAULT 'OPEN' NOT NULL,
	"closed_at" timestamp with time zone,
	"closed_by" uuid
);
--> statement-breakpoint
CREATE TABLE "app"."cash_deposit" (
	"id" uuid PRIMARY KEY NOT NULL,
	"date" date NOT NULL,
	"kind" "app"."deposit_kind" NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"bank_account_id" uuid NOT NULL,
	"cheque_list" jsonb,
	"comment" text,
	"entry_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"legacy_ref" text,
	CONSTRAINT "cash_deposit_legacy_ref_unique" UNIQUE("legacy_ref")
);
--> statement-breakpoint
CREATE TABLE "app"."entry" (
	"id" uuid PRIMARY KEY NOT NULL,
	"journal_id" uuid NOT NULL,
	"fiscal_year_id" uuid NOT NULL,
	"number" integer,
	"date" date NOT NULL,
	"piece_ref" text,
	"label" text NOT NULL,
	"mode" "app"."entry_mode",
	"status" "app"."entry_status" DEFAULT 'DRAFT' NOT NULL,
	"source_type" text,
	"source_id" text,
	"reverses_entry_id" uuid,
	"validated_at" timestamp with time zone,
	"validated_by" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"legacy_mvtnum" integer,
	CONSTRAINT "entry_legacy_mvtnum_unique" UNIQUE("legacy_mvtnum"),
	CONSTRAINT "entry_validated_has_number" CHECK ("app"."entry"."status" = 'DRAFT' or "app"."entry"."number" is not null)
);
--> statement-breakpoint
CREATE TABLE "app"."entry_line" (
	"id" uuid PRIMARY KEY NOT NULL,
	"entry_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"account_id" uuid NOT NULL,
	"label" text NOT NULL,
	"debit" numeric(12, 2) DEFAULT '0' NOT NULL,
	"credit" numeric(12, 2) DEFAULT '0' NOT NULL,
	"reconciliation_id" uuid,
	"lettering_code" text,
	"lettered_on" date,
	CONSTRAINT "entry_line_amounts" CHECK ("app"."entry_line"."debit" >= 0 and "app"."entry_line"."credit" >= 0 and ("app"."entry_line"."debit" = 0 or "app"."entry_line"."credit" = 0))
);
--> statement-breakpoint
CREATE TABLE "app"."entry_template" (
	"id" uuid PRIMARY KEY NOT NULL,
	"category_code" text,
	"journal_id" uuid NOT NULL,
	"label" text NOT NULL,
	"mode" "app"."entry_mode",
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"legacy_guinum" integer,
	CONSTRAINT "entry_template_legacy_guinum_unique" UNIQUE("legacy_guinum")
);
--> statement-breakpoint
CREATE TABLE "app"."entry_template_category" (
	"code" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."entry_template_line" (
	"id" uuid PRIMARY KEY NOT NULL,
	"template_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"account_id" uuid NOT NULL,
	"label" text NOT NULL,
	"debit" numeric(12, 2),
	"credit" numeric(12, 2)
);
--> statement-breakpoint
CREATE TABLE "app"."fiscal_year" (
	"id" uuid PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date NOT NULL,
	"status" "app"."fiscal_year_status" DEFAULT 'OPEN' NOT NULL,
	"closed_at" timestamp with time zone,
	"closed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fiscal_year_dates" CHECK ("app"."fiscal_year"."end_date" >= "app"."fiscal_year"."start_date")
);
--> statement-breakpoint
CREATE TABLE "app"."journal" (
	"id" uuid PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"label" text NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "journal_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "app"."reconciliation" (
	"id" uuid PRIMARY KEY NOT NULL,
	"statement_id" uuid,
	"label" text NOT NULL,
	"done_at" timestamp with time zone DEFAULT now() NOT NULL,
	"done_by" uuid
);
--> statement-breakpoint
ALTER TABLE "app"."cash_session" ADD COLUMN "entry_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."category" ADD COLUMN "sales_account_number" text;--> statement-breakpoint
ALTER TABLE "app"."member_payment" ADD COLUMN "bank_line_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."supplier_invoice" ADD COLUMN "entry_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."supplier_invoice" ADD COLUMN "payment_entry_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."supplier_invoice" ADD COLUMN "expense_account_number" text;--> statement-breakpoint
ALTER TABLE "app"."bank_account" ADD CONSTRAINT "bank_account_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "app"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."bank_line" ADD CONSTRAINT "bank_line_statement_id_bank_statement_id_fk" FOREIGN KEY ("statement_id") REFERENCES "app"."bank_statement"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."bank_line" ADD CONSTRAINT "bank_line_bank_account_id_bank_account_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "app"."bank_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."bank_line" ADD CONSTRAINT "bank_line_entry_line_id_entry_line_id_fk" FOREIGN KEY ("entry_line_id") REFERENCES "app"."entry_line"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."bank_line" ADD CONSTRAINT "bank_line_rule_id_bank_rule_id_fk" FOREIGN KEY ("rule_id") REFERENCES "app"."bank_rule"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."bank_rule" ADD CONSTRAINT "bank_rule_counter_account_id_account_id_fk" FOREIGN KEY ("counter_account_id") REFERENCES "app"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."bank_rule" ADD CONSTRAINT "bank_rule_journal_id_journal_id_fk" FOREIGN KEY ("journal_id") REFERENCES "app"."journal"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."bank_rule" ADD CONSTRAINT "bank_rule_supplier_id_supplier_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "app"."supplier"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."bank_statement" ADD CONSTRAINT "bank_statement_bank_account_id_bank_account_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "app"."bank_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."bank_statement" ADD CONSTRAINT "bank_statement_imported_by_member_id_fk" FOREIGN KEY ("imported_by") REFERENCES "app"."member"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."bank_statement" ADD CONSTRAINT "bank_statement_closed_by_member_id_fk" FOREIGN KEY ("closed_by") REFERENCES "app"."member"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."cash_deposit" ADD CONSTRAINT "cash_deposit_bank_account_id_bank_account_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "app"."bank_account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."cash_deposit" ADD CONSTRAINT "cash_deposit_entry_id_entry_id_fk" FOREIGN KEY ("entry_id") REFERENCES "app"."entry"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."cash_deposit" ADD CONSTRAINT "cash_deposit_created_by_member_id_fk" FOREIGN KEY ("created_by") REFERENCES "app"."member"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."entry" ADD CONSTRAINT "entry_journal_id_journal_id_fk" FOREIGN KEY ("journal_id") REFERENCES "app"."journal"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."entry" ADD CONSTRAINT "entry_fiscal_year_id_fiscal_year_id_fk" FOREIGN KEY ("fiscal_year_id") REFERENCES "app"."fiscal_year"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."entry" ADD CONSTRAINT "entry_reverses_entry_id_entry_id_fk" FOREIGN KEY ("reverses_entry_id") REFERENCES "app"."entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."entry" ADD CONSTRAINT "entry_validated_by_member_id_fk" FOREIGN KEY ("validated_by") REFERENCES "app"."member"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."entry" ADD CONSTRAINT "entry_created_by_member_id_fk" FOREIGN KEY ("created_by") REFERENCES "app"."member"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."entry_line" ADD CONSTRAINT "entry_line_entry_id_entry_id_fk" FOREIGN KEY ("entry_id") REFERENCES "app"."entry"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."entry_line" ADD CONSTRAINT "entry_line_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "app"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."entry_line" ADD CONSTRAINT "entry_line_reconciliation_id_reconciliation_id_fk" FOREIGN KEY ("reconciliation_id") REFERENCES "app"."reconciliation"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."entry_template" ADD CONSTRAINT "entry_template_category_code_entry_template_category_code_fk" FOREIGN KEY ("category_code") REFERENCES "app"."entry_template_category"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."entry_template" ADD CONSTRAINT "entry_template_journal_id_journal_id_fk" FOREIGN KEY ("journal_id") REFERENCES "app"."journal"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."entry_template_line" ADD CONSTRAINT "entry_template_line_template_id_entry_template_id_fk" FOREIGN KEY ("template_id") REFERENCES "app"."entry_template"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."entry_template_line" ADD CONSTRAINT "entry_template_line_account_id_account_id_fk" FOREIGN KEY ("account_id") REFERENCES "app"."account"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."fiscal_year" ADD CONSTRAINT "fiscal_year_closed_by_member_id_fk" FOREIGN KEY ("closed_by") REFERENCES "app"."member"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."reconciliation" ADD CONSTRAINT "reconciliation_done_by_member_id_fk" FOREIGN KEY ("done_by") REFERENCES "app"."member"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bank_line_fitid_uq" ON "app"."bank_line" USING btree ("bank_account_id","fitid") WHERE "app"."bank_line"."fitid" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "bank_line_fingerprint_uq" ON "app"."bank_line" USING btree ("bank_account_id","fingerprint");--> statement-breakpoint
CREATE INDEX "bank_line_statement_idx" ON "app"."bank_line" USING btree ("statement_id");--> statement-breakpoint
CREATE INDEX "bank_rule_priority_idx" ON "app"."bank_rule" USING btree ("priority");--> statement-breakpoint
CREATE UNIQUE INDEX "bank_statement_file_uq" ON "app"."bank_statement" USING btree ("bank_account_id","file_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "entry_number_uq" ON "app"."entry" USING btree ("journal_id","fiscal_year_id","number") WHERE "app"."entry"."number" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "entry_source_uq" ON "app"."entry" USING btree ("source_type","source_id") WHERE "app"."entry"."source_type" is not null and "app"."entry"."source_id" is not null;--> statement-breakpoint
CREATE INDEX "entry_date_idx" ON "app"."entry" USING btree ("date");--> statement-breakpoint
CREATE INDEX "entry_year_journal_idx" ON "app"."entry" USING btree ("fiscal_year_id","journal_id");--> statement-breakpoint
CREATE INDEX "entry_line_entry_idx" ON "app"."entry_line" USING btree ("entry_id");--> statement-breakpoint
CREATE INDEX "entry_line_account_idx" ON "app"."entry_line" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "entry_line_lettering_idx" ON "app"."entry_line" USING btree ("lettering_code");--> statement-breakpoint
CREATE INDEX "entry_template_line_idx" ON "app"."entry_template_line" USING btree ("template_id");--> statement-breakpoint
ALTER TABLE "app"."cash_session" ADD CONSTRAINT "cash_session_entry_id_entry_id_fk" FOREIGN KEY ("entry_id") REFERENCES "app"."entry"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."member_payment" ADD CONSTRAINT "member_payment_bank_line_id_bank_line_id_fk" FOREIGN KEY ("bank_line_id") REFERENCES "app"."bank_line"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."supplier_invoice" ADD CONSTRAINT "supplier_invoice_entry_id_entry_id_fk" FOREIGN KEY ("entry_id") REFERENCES "app"."entry"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."supplier_invoice" ADD CONSTRAINT "supplier_invoice_payment_entry_id_entry_id_fk" FOREIGN KEY ("payment_entry_id") REFERENCES "app"."entry"("id") ON DELETE set null ON UPDATE no action;