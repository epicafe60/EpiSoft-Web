-- Review of November 2026 (M1, M2, M4): what the database refuses to the application's role, so that
-- a flaw in the application can neither rewrite the history of the till nor the validated accounts.
--
-- « The owner » below is the role that owns the table (episoft_owner after deploy/db/split-roles.sql):
-- the migrations, a restore, a repair by hand. Before the roles are split the application owns the
-- tables and the guards do not hold it, exactly as it could drop them: the protection comes with the
-- split (docs/maintenance.md, « Database roles »).

-- R-CAG-08: a top-up entered by mistake is cancelled by an entry of the opposite amount.
ALTER TABLE "app"."wallet_entry" ADD COLUMN "cancels_entry_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."wallet_entry" ADD CONSTRAINT "wallet_entry_cancels_entry_id_wallet_entry_id_fk" FOREIGN KEY ("cancels_entry_id") REFERENCES "app"."wallet_entry"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_entry_one_cancellation" ON "app"."wallet_entry" USING btree ("cancels_entry_id") WHERE "app"."wallet_entry"."cancels_entry_id" is not null;--> statement-breakpoint
-- NOT VALID: the sessions already there are not re-checked, every new one is.
ALTER TABLE "app"."cash_session" ADD CONSTRAINT "cash_session_opening_float_not_negative" CHECK ("app"."cash_session"."opening_float" >= 0) NOT VALID;--> statement-breakpoint

-- M1: tickets, their lines and payments, stock movements, cagnotte entries and member payments are
-- history. The application adds to them; it never deletes a row, and changes only the columns
-- listed when the guard is attached (the state of a ticket, never its amounts).
CREATE FUNCTION "app"."history_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  -- The columns that may change. TG_ARGV is null, not empty, for a trigger without arguments.
  free text[] := coalesce(TG_ARGV, '{}'::text[]);
BEGIN
  IF pg_has_role(current_user, (SELECT relowner FROM pg_catalog.pg_class WHERE oid = TG_RELID), 'USAGE') THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '% is history: a row cannot be deleted', TG_TABLE_NAME USING ERRCODE = '23000';
  END IF;
  IF (to_jsonb(NEW) - free) IS DISTINCT FROM (to_jsonb(OLD) - free) THEN
    RAISE EXCEPTION '% is history: only % may change', TG_TABLE_NAME,
      coalesce(nullif(array_to_string(free, ', '), ''), 'nothing') USING ERRCODE = '23000';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
-- discount_total is the sum of the lines' discounts: the integrity check VTE-04 may recompute it.
CREATE TRIGGER "history_guard" BEFORE UPDATE OR DELETE ON "app"."sale"
  FOR EACH ROW EXECUTE FUNCTION "app"."history_guard"('status', 'warnings', 'warnings_reviewed_at', 'email_sent_at', 'discount_total');
--> statement-breakpoint
CREATE TRIGGER "history_guard" BEFORE UPDATE OR DELETE ON "app"."sale_line"
  FOR EACH ROW EXECUTE FUNCTION "app"."history_guard"();
--> statement-breakpoint
CREATE TRIGGER "history_guard" BEFORE UPDATE OR DELETE ON "app"."sale_payment"
  FOR EACH ROW EXECUTE FUNCTION "app"."history_guard"();
--> statement-breakpoint
CREATE TRIGGER "history_guard" BEFORE UPDATE OR DELETE ON "app"."stock_movement"
  FOR EACH ROW EXECUTE FUNCTION "app"."history_guard"();
--> statement-breakpoint
CREATE TRIGGER "history_guard" BEFORE UPDATE OR DELETE ON "app"."wallet_entry"
  FOR EACH ROW EXECUTE FUNCTION "app"."history_guard"();
--> statement-breakpoint
CREATE TRIGGER "history_guard" BEFORE UPDATE OR DELETE ON "app"."member_payment"
  FOR EACH ROW EXECUTE FUNCTION "app"."history_guard"();
--> statement-breakpoint

-- M2: the guards of the validated entries (migration 0007) were lifted by a setting any session can
-- change (app.bypass_entry_guard). The setting now counts for the owner only: the application's role
-- cannot lift them, whatever SQL it is made to run.
CREATE OR REPLACE FUNCTION "app"."entry_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  d numeric;
  c numeric;
  n integer;
BEGIN
  IF current_setting('app.bypass_entry_guard', true) = 'on'
     AND pg_has_role(current_user, (SELECT relowner FROM pg_catalog.pg_class WHERE oid = TG_RELID), 'USAGE') THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'VALIDATED' THEN
      RAISE EXCEPTION 'entry is validated and cannot be deleted' USING ERRCODE = '23000';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'VALIDATED' THEN
    RAISE EXCEPTION 'entry is validated and cannot be modified' USING ERRCODE = '23000';
  END IF;
  IF NEW.status = 'VALIDATED' THEN
    SELECT COALESCE(SUM(debit), 0), COALESCE(SUM(credit), 0), COUNT(*) INTO d, c, n
      FROM "app"."entry_line" WHERE entry_id = NEW.id;
    IF n < 2 OR d <> c THEN
      RAISE EXCEPTION 'entry is not balanced (debit %, credit %, % lines)', d, c, n USING ERRCODE = '23000';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "app"."entry_line_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  parent_status "app"."entry_status";
  parent_id uuid;
BEGIN
  IF current_setting('app.bypass_entry_guard', true) = 'on'
     AND pg_has_role(current_user, (SELECT relowner FROM pg_catalog.pg_class WHERE oid = TG_RELID), 'USAGE') THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  parent_id := COALESCE(NEW.entry_id, OLD.entry_id);
  SELECT status INTO parent_status FROM "app"."entry" WHERE id = parent_id;
  IF parent_status IS DISTINCT FROM 'VALIDATED' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  IF TG_OP = 'UPDATE'
     AND NEW.entry_id = OLD.entry_id AND NEW.line_no = OLD.line_no AND NEW.account_id = OLD.account_id
     AND NEW.label = OLD.label AND NEW.debit = OLD.debit AND NEW.credit = OLD.credit THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'lines of a validated entry cannot be changed' USING ERRCODE = '23000';
END;
$$;
--> statement-breakpoint

-- The one thing the application still has to remove from validated entries: the closing entries of
-- a fiscal year it reopens (stock, result, « à-nouveaux »; they are generated again at the next
-- closing). It runs with the rights of the owner, does only that, and only for a closed year. Its
-- search_path is fixed, so that no object of another schema can be slipped in.
CREATE FUNCTION "app"."remove_closing_entries"(fy uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  n integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "app"."fiscal_year" WHERE id = fy AND status = 'CLOSED') THEN
    RAISE EXCEPTION 'fiscal year is not closed' USING ERRCODE = '23000';
  END IF;
  PERFORM set_config('app.bypass_entry_guard', 'on', true);
  DELETE FROM "app"."entry_line" WHERE entry_id IN (
    SELECT id FROM "app"."entry"
     WHERE source_id = fy::text AND source_type IN ('closing_stock', 'closing_result', 'closing_ran'));
  DELETE FROM "app"."entry"
   WHERE source_id = fy::text AND source_type IN ('closing_stock', 'closing_result', 'closing_ran');
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM set_config('app.bypass_entry_guard', 'off', true);
  RETURN n;
END;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "app"."remove_closing_entries"(uuid) FROM PUBLIC;
