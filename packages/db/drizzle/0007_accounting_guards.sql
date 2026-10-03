-- Lot 3 guards: what the application must never be able to do, enforced by the database.
-- Spec principle 7 and R-CPT-05: a validated entry cannot be modified, only reversed.

-- R-CPT-03: fiscal years never overlap.
ALTER TABLE "app"."fiscal_year"
  ADD CONSTRAINT "fiscal_year_no_overlap" EXCLUDE USING gist (daterange("start_date", "end_date", '[]') WITH &&);
--> statement-breakpoint

-- An entry: no update or delete once validated; validating requires a balanced entry of at
-- least two lines. Reopening a fiscal year (ADMIN, audited) sets app.bypass_entry_guard.
CREATE FUNCTION "app"."entry_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  d numeric;
  c numeric;
  n integer;
BEGIN
  IF current_setting('app.bypass_entry_guard', true) = 'on' THEN
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
CREATE TRIGGER "entry_guard" BEFORE UPDATE OR DELETE ON "app"."entry"
  FOR EACH ROW EXECUTE FUNCTION "app"."entry_guard"();
--> statement-breakpoint

-- Lines of a validated entry: no insert, delete or change of the amounts and the account.
-- Only the reconciliation and lettering markers may change.
CREATE FUNCTION "app"."entry_line_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  parent_status "app"."entry_status";
  parent_id uuid;
BEGIN
  IF current_setting('app.bypass_entry_guard', true) = 'on' THEN
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
CREATE TRIGGER "entry_line_guard" BEFORE INSERT OR UPDATE OR DELETE ON "app"."entry_line"
  FOR EACH ROW EXECUTE FUNCTION "app"."entry_line_guard"();
--> statement-breakpoint

-- Statements link back to reconciliations (declared without a foreign key to avoid a cycle).
ALTER TABLE "app"."reconciliation"
  ADD CONSTRAINT "reconciliation_statement_fk" FOREIGN KEY ("statement_id") REFERENCES "app"."bank_statement"("id") ON DELETE SET NULL;
