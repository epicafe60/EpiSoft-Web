-- ADR 0016 (caisse inaltérable): what the database refuses to the application's role around the
-- chained journal, the closings of period and the tickets of a closed day. « The owner » is the
-- role that owns the tables (see 0031): migrations, restore, repair by hand. The integrity check
-- (FIS-01 to FIS-06) still finds what the owner changes.

-- The tickets already there are counted on the day they were sold (Paris time). The journal starts
-- at the migration: tickets issued before it were never sealed, and are not sealed after the fact.
UPDATE "app"."sale" SET "accounting_day" = (("sold_at" AT TIME ZONE 'Europe/Paris')::date)
  WHERE "accounting_day" = date '1970-01-01';--> statement-breakpoint

-- Journal, closings and reprints are history: added to, never changed nor deleted.
CREATE TRIGGER "history_guard" BEFORE UPDATE OR DELETE ON "app"."fiscal_journal"
  FOR EACH ROW EXECUTE FUNCTION "app"."history_guard"();--> statement-breakpoint
CREATE TRIGGER "history_guard" BEFORE UPDATE OR DELETE ON "app"."period_closing"
  FOR EACH ROW EXECUTE FUNCTION "app"."history_guard"();--> statement-breakpoint
CREATE TRIGGER "history_guard" BEFORE UPDATE OR DELETE ON "app"."ticket_reprint"
  FOR EACH ROW EXECUTE FUNCTION "app"."history_guard"();--> statement-breakpoint

-- A ticket is never added to a closed day. The code gives the accounting day; when it is left to
-- the default (the migration of the old application, a script), it is the day sold.
CREATE FUNCTION "app"."sale_period_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.accounting_day = date '1970-01-01' THEN
    NEW.accounting_day := (NEW.sold_at AT TIME ZONE 'Europe/Paris')::date;
  END IF;
  IF EXISTS (SELECT 1 FROM app.period_closing c WHERE c.kind = 'DAY' AND c.period_start = NEW.accounting_day) THEN
    RAISE EXCEPTION 'the day % is closed: no ticket can be added to it', NEW.accounting_day
      USING ERRCODE = '23000';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "sale_period_guard" BEFORE INSERT ON "app"."sale"
  FOR EACH ROW EXECUTE FUNCTION "app"."sale_period_guard"();--> statement-breakpoint

-- A session holding tickets of a closed day cannot be reopened (outside the owner).
CREATE FUNCTION "app"."cash_session_reopen_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'CLOSED' AND NEW.status = 'OPEN'
     AND NOT pg_has_role(current_user, (SELECT relowner FROM pg_catalog.pg_class WHERE oid = TG_RELID), 'USAGE')
     AND EXISTS (SELECT 1 FROM app.sale s JOIN app.period_closing c
                   ON c.kind = 'DAY' AND c.period_start = s.accounting_day
                 WHERE s.session_id = OLD.id) THEN
    RAISE EXCEPTION 'the day of this session is closed: it cannot be reopened' USING ERRCODE = '23000';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "cash_session_reopen_guard" BEFORE UPDATE ON "app"."cash_session"
  FOR EACH ROW EXECUTE FUNCTION "app"."cash_session_reopen_guard"();--> statement-breakpoint

select app.attach_change_capture();
