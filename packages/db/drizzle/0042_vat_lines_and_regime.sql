CREATE TYPE "app"."vat_regime" AS ENUM('LIABLE', 'FRANCHISE', 'EXEMPT');--> statement-breakpoint
CREATE TABLE "app"."supplier_invoice_vat_line" (
	"id" uuid PRIMARY KEY NOT NULL,
	"invoice_id" uuid NOT NULL,
	"rate" numeric(5, 2) NOT NULL,
	"excl" numeric(12, 2) NOT NULL,
	"vat" numeric(12, 2) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."vat_regime_change" (
	"id" uuid PRIMARY KEY NOT NULL,
	"effective_from" date NOT NULL,
	"regime" "app"."vat_regime" NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vat_regime_change_effective_from_unique" UNIQUE("effective_from")
);
--> statement-breakpoint
ALTER TABLE "app"."sale" ADD COLUMN "vat_regime" "app"."vat_regime" DEFAULT 'LIABLE' NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."supplier_invoice" ADD COLUMN "vat_regime" "app"."vat_regime" DEFAULT 'LIABLE' NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."supplier_invoice_vat_line" ADD CONSTRAINT "supplier_invoice_vat_line_invoice_id_supplier_invoice_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "app"."supplier_invoice"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."vat_regime_change" ADD CONSTRAINT "vat_regime_change_created_by_member_id_fk" FOREIGN KEY ("created_by") REFERENCES "app"."member"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "supplier_invoice_vat_line_rate_uq" ON "app"."supplier_invoice_vat_line" USING btree ("invoice_id","rate");