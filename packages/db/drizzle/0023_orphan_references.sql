-- Rows whose foreign key points to nothing. The database refuses them, unless its constraints were
-- bypassed (a data load without triggers, a manual repair): the integrity check REF-01 finds them,
-- because a database in that state does not restore cleanly from its own backup. Read-only.
CREATE OR REPLACE FUNCTION app.orphan_references()
RETURNS TABLE (constraint_name text, child_table text, parent_table text, orphans bigint)
LANGUAGE plpgsql STABLE AS $$
DECLARE
  r record;
  n bigint;
BEGIN
  FOR r IN
    SELECT c.conname::text AS conname,
           c.conrelid::regclass::text AS child,
           c.confrelid::regclass::text AS parent,
           (SELECT string_agg('ch.' || quote_ident(a.attname), ',' ORDER BY k.ord)
              FROM unnest(c.conkey) WITH ORDINALITY k(att, ord)
              JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.att) AS ccols,
           (SELECT string_agg('p.' || quote_ident(a.attname), ',' ORDER BY k.ord)
              FROM unnest(c.confkey) WITH ORDINALITY k(att, ord)
              JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.att) AS pcols
    FROM pg_constraint c
    JOIN pg_namespace ns ON ns.oid = c.connamespace
    WHERE c.contype = 'f' AND ns.nspname = 'app'
  LOOP
    EXECUTE format(
      'SELECT count(*) FROM %s ch WHERE (%s) IS NOT NULL AND NOT EXISTS (SELECT 1 FROM %s p WHERE (%s) = (%s))',
      r.child, r.ccols, r.parent, r.pcols, r.ccols)
    INTO n;
    IF n > 0 THEN
      constraint_name := r.conname;
      child_table := r.child;
      parent_table := r.parent;
      orphans := n;
      RETURN NEXT;
    END IF;
  END LOOP;
END $$;
