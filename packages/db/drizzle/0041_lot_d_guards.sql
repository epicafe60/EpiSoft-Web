-- Lot D: guards of the closed years, numbering without gaps, weighted average cost backfill.

-- 1. An approved year (accounts approved by the general assembly) is inalterable: it can never go
-- back to OPEN, the approval cannot be removed, and only a closed year can be approved. The owner's
-- bypass (restore, repair by hand) is deliberately not offered here.
CREATE FUNCTION "app"."fiscal_year_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.approved_at IS NOT NULL THEN
    IF NEW.status IS DISTINCT FROM OLD.status
       OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
       OR NEW.approved_on IS DISTINCT FROM OLD.approved_on
       OR NEW.approval_reference IS DISTINCT FROM OLD.approval_reference
       OR NEW.start_date IS DISTINCT FROM OLD.start_date
       OR NEW.end_date IS DISTINCT FROM OLD.end_date THEN
      RAISE EXCEPTION 'fiscal year % is approved and cannot be changed', OLD.label USING ERRCODE = '23000';
    END IF;
  ELSIF NEW.approved_at IS NOT NULL AND NEW.status <> 'CLOSED' THEN
    RAISE EXCEPTION 'only a closed fiscal year can be approved' USING ERRCODE = '23000';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "fiscal_year_guard" BEFORE UPDATE ON "app"."fiscal_year"
  FOR EACH ROW EXECUTE FUNCTION "app"."fiscal_year_guard"();
--> statement-breakpoint

-- 2. Removing the closing entries of a reopened year leaves no hole in the numbering: the counters of
-- the journals concerned are set back to the highest number still used. An approved year is refused.
CREATE OR REPLACE FUNCTION "app"."remove_closing_entries"(fy uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  n integer;
  jids uuid[];
  fids uuid[];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "app"."fiscal_year" WHERE id = fy AND status = 'CLOSED' AND approved_at IS NULL) THEN
    RAISE EXCEPTION 'fiscal year is not closed or is approved' USING ERRCODE = '23000';
  END IF;
  PERFORM set_config('app.bypass_entry_guard', 'on', true);
  SELECT array_agg(DISTINCT journal_id), array_agg(DISTINCT fiscal_year_id) INTO jids, fids
    FROM "app"."entry"
   WHERE source_id = fy::text AND source_type IN ('closing_stock', 'closing_result', 'closing_ran');
  DELETE FROM "app"."entry_line" WHERE entry_id IN (
    SELECT id FROM "app"."entry"
     WHERE source_id = fy::text AND source_type IN ('closing_stock', 'closing_result', 'closing_ran'));
  DELETE FROM "app"."entry"
   WHERE source_id = fy::text AND source_type IN ('closing_stock', 'closing_result', 'closing_ran');
  GET DIAGNOSTICS n = ROW_COUNT;
  IF jids IS NOT NULL THEN
    UPDATE "app"."number_counter" c
       SET value = coalesce((SELECT max(e.number) FROM "app"."entry" e
                              WHERE e.journal_id = split_part(substr(c.key, 7), ':', 1)::uuid
                                AND e.fiscal_year_id = split_part(substr(c.key, 7), ':', 2)::uuid), 0)
     WHERE c.key LIKE 'entry:%'
       AND split_part(substr(c.key, 7), ':', 1)::uuid = ANY (jids)
       AND split_part(substr(c.key, 7), ':', 2)::uuid = ANY (fids);
  END IF;
  PERFORM set_config('app.bypass_entry_guard', 'off', true);
  RETURN n;
END;
$$;
--> statement-breakpoint

-- 3. R-STK-06: running weighted average cost (CMUP) replayed over the existing movements.
-- Entries at a cost (PURCHASE_IN, INITIAL) weigh into the average; other movements leave it alone.
DO $$
DECLARE
  p record;
  m record;
  q numeric;
  a numeric;
  c numeric;
BEGIN
  FOR p IN SELECT id FROM "app"."product" LOOP
    q := 0;
    a := NULL;
    FOR m IN SELECT id, qty, kind, unit_cost FROM "app"."stock_movement"
              WHERE product_id = p.id ORDER BY at, id LOOP
      c := m.unit_cost;
      IF m.qty > 0 AND c IS NOT NULL AND (m.kind IN ('PURCHASE_IN', 'INITIAL') OR a IS NULL) THEN
        IF q <= 0 OR a IS NULL THEN
          a := round(c, 6);
        ELSE
          a := round((q * a + m.qty * c) / (q + m.qty), 6);
        END IF;
      END IF;
      q := q + m.qty;
      UPDATE "app"."stock_movement" SET avg_cost_after = a WHERE id = m.id;
    END LOOP;
    UPDATE "app"."product" SET avg_cost = a WHERE id = p.id AND a IS NOT NULL;
  END LOOP;
END;
$$;
--> statement-breakpoint

SELECT app.attach_change_capture();
