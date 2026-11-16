-- Data retention (ADR 0017): what the purge may delete, and nothing else.
--
-- The purge works on a closed list of technical tables, journals and sessions (see retention_run
-- below). The history tables (sale, sale_line, sale_payment, stock_movement, wallet_entry,
-- member_payment: history_guard of migration 0031) and the validated accounting entries
-- (entry_guard) are not in that list and their guards are untouched.
--
-- Two things have to give way for the purge, and only for the purge:
--  1. audit_log and data_change are append-only (audit_log_immutable): a DELETE is let through when
--     the session says so (episoft.purge = 'on') AND the current role owns the table. The
--     application's role does not own it after the roles are split (deploy/db/split-roles.sql), and
--     it has no DELETE right on the journals either: it can only go through retention_run(), which
--     runs with the rights of the owner. Before the split the application owns the tables and the
--     guard does not hold it, exactly as for history_guard (migration 0031).
--  2. the rows the purge deletes are not copied into data_change (that would write, for every row
--     purged, a row of the journal being purged). Same condition. The purge is recorded by one
--     audit_log row of its own (action retention.purge), not row by row.

CREATE OR REPLACE FUNCTION "app"."audit_log_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND current_setting('episoft.scrub', true) = 'on' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' AND current_setting('episoft.purge', true) = 'on'
     AND pg_has_role(current_user, (SELECT relowner FROM pg_catalog.pg_class WHERE oid = TG_RELID), 'USAGE') THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$;
--> statement-breakpoint

-- Same as migration 0024, plus: nothing is recorded while the purge deletes (point 2 above).
CREATE OR REPLACE FUNCTION "app"."capture_change"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  o jsonb := CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) END;
  n jsonb := CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) END;
  k jsonb;
  arg text;
  col text;
BEGIN
  IF current_setting('episoft.purge', true) = 'on'
     AND pg_has_role(current_user, (SELECT relowner FROM pg_catalog.pg_class WHERE oid = TG_RELID), 'USAGE') THEN
    RETURN NULL;
  END IF;
  FOREACH arg IN ARRAY coalesce(TG_ARGV, '{}'::text[]) LOOP
    IF arg LIKE 'pk:%' THEN
      col := substr(arg, 4);
      k := coalesce(k, '{}'::jsonb) || jsonb_build_object(col, coalesce(n, o) -> col);
    END IF;
  END LOOP;
  -- An update keeps only the columns that changed; an update that changes nothing is not recorded.
  IF TG_OP = 'UPDATE' THEN
    SELECT jsonb_object_agg(e.key, e.value), jsonb_object_agg(e.key, n -> e.key)
      INTO o, n
      FROM jsonb_each(o) e
     WHERE e.value IS DISTINCT FROM n -> e.key;
    FOREACH arg IN ARRAY coalesce(TG_ARGV, '{}'::text[]) LOOP
      IF arg LIKE 'skip:%' THEN
        o := o - substr(arg, 6);
        n := n - substr(arg, 6);
      END IF;
    END LOOP;
    IF o IS NULL OR o = '{}'::jsonb THEN
      RETURN NULL;
    END IF;
  END IF;
  FOREACH arg IN ARRAY coalesce(TG_ARGV, '{}'::text[]) LOOP
    col := substr(arg, strpos(arg, ':') + 1);
    IF arg LIKE 'mask:%' THEN
      IF o ? col AND o -> col <> 'null'::jsonb THEN o := jsonb_set(o, ARRAY[col], '"***"'); END IF;
      IF n ? col AND n -> col <> 'null'::jsonb THEN n := jsonb_set(n, ARRAY[col], '"***"'); END IF;
    ELSIF arg LIKE 'size:%' THEN
      IF o ? col AND o -> col <> 'null'::jsonb THEN
        o := jsonb_set(o, ARRAY[col], jsonb_build_object('octets', (length(o ->> col) - 2) / 2));
      END IF;
      IF n ? col AND n -> col <> 'null'::jsonb THEN
        n := jsonb_set(n, ARRAY[col], jsonb_build_object('octets', (length(n ->> col) - 2) / 2));
      END IF;
    ELSIF arg LIKE 'drop:%' THEN
      o := o - col;
      n := n - col;
    END IF;
  END LOOP;
  INSERT INTO "app"."data_change" (table_name, row_key, op, old, new, source)
  VALUES (TG_TABLE_NAME, k, left(TG_OP, 1), o, n, nullif(current_setting('episoft.source', true), ''));
  RETURN NULL;
END $$;
--> statement-breakpoint

-- One batch of the purge of one kind, or its count (the dry run). The predicate of a kind is written
-- once, here: the preview, the archive and the deletion cannot disagree.
--   p_kind   a kind of the closed list below (anything else is refused)
--   p_cutoff what is older than this goes
--   p_batch  rows per batch (the caller loops until a batch comes back short)
--   p_mode   'count' (nothing changes), 'purge', or 'archive' (purge, and give back what went)
--   p_keys   audit_log: the actions of the class; data_change: the tables of the class
-- Returns n rows concerned, bytes they hold (count mode: an estimate of the data, not of the
-- indexes), and, in archive mode, the rows as [{table, row}].
CREATE FUNCTION "app"."retention_run"(
  p_kind text, p_cutoff timestamptz, p_batch integer, p_mode text, p_keys text[] DEFAULT '{}'::text[]
) RETURNS TABLE (n bigint, bytes bigint, removed jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_table text;
  v_pred text;
  v_op text := 'delete';
  v_set text;
  v_size text := 'pg_column_size(t.*)';
  v_archive boolean := p_mode = 'archive';
  v_ids uuid[];
  v_n bigint;
  v_removed jsonb;
  v_purged_mail constant text := '<p><em>Contenu supprimé : durée de conservation dépassée.</em></p>';
BEGIN
  IF p_mode NOT IN ('count', 'purge', 'archive') THEN
    RAISE EXCEPTION 'retention_run: unknown mode %', p_mode;
  END IF;
  IF p_batch IS NULL OR p_batch < 1 OR p_batch > 100000 THEN
    RAISE EXCEPTION 'retention_run: batch size out of range';
  END IF;

  CASE p_kind
    WHEN 'email_body' THEN
      -- A sent e-mail keeps its line (to, subject, date); its content goes. Failed ones are left as
      -- they are: « renvoyer » needs the content.
      v_table := 'email_outbox'; v_op := 'update';
      v_set := format('html = %L, text = NULL, attachments = NULL', v_purged_mail);
      v_pred := format('t.status = ''SENT'' AND coalesce(t.sent_at, t.created_at) < $1 AND (t.html <> %L OR t.text IS NOT NULL OR t.attachments IS NOT NULL)', v_purged_mail);
      v_size := 'coalesce(pg_column_size(t.html), 0) + coalesce(pg_column_size(t.text), 0) + coalesce(pg_column_size(t.attachments), 0)';
    WHEN 'email_rows' THEN
      v_table := 'email_outbox';
      v_pred := 't.status <> ''PENDING'' AND t.created_at < $1';
    WHEN 'error_log' THEN
      v_table := 'error_log'; v_pred := 't.last_at < $1';
    WHEN 'sync_receipt' THEN
      v_table := 'sync_receipt'; v_pred := 't.received_at < $1';
    WHEN 'sync_rejection' THEN
      v_table := 'sync_rejection'; v_pred := 't.acknowledged_at IS NOT NULL AND t.at < $1';
    WHEN 'job_run' THEN
      v_table := 'job_run'; v_pred := 't.day < $1::date';
    WHEN 'integrity_run' THEN
      -- The latest run stays: « À surveiller » reads it.
      v_table := 'integrity_run';
      v_pred := 't.at < $1 AND EXISTS (SELECT 1 FROM "app"."integrity_run" z WHERE z.at > t.at)';
    WHEN 'wallet_snapshot' THEN
      -- The latest photograph of each household stays: the check CAG-05 starts from it.
      v_table := 'wallet_snapshot';
      v_pred := 't.day < $1::date AND EXISTS (SELECT 1 FROM "app"."wallet_snapshot" z WHERE z.household_id = t.household_id AND z.day > t.day)';
    WHEN 'backup_run' THEN
      v_table := 'backup_run';
      v_pred := 't.at < $1 AND EXISTS (SELECT 1 FROM "app"."backup_run" z WHERE z.kind = t.kind AND z.ok = t.ok AND z.at > t.at)';
    WHEN 'till_pin_attempt' THEN
      v_table := 'till_pin_attempt'; v_pred := 't.at < $1';
    WHEN 'session' THEN
      v_table := 'session'; v_pred := 't.expires_at < $1';
    WHEN 'password_reset_token' THEN
      v_table := 'password_reset_token'; v_pred := 't.expires_at < $1';
    WHEN 'login_log' THEN
      v_table := 'login_log'; v_pred := 't.at < $1';
    WHEN 'price_history' THEN
      -- The latest price of each product stays.
      v_table := 'price_history';
      v_pred := 't.at < $1 AND EXISTS (SELECT 1 FROM "app"."price_history" z WHERE z.product_id = t.product_id AND z.at > t.at)';
    WHEN 'feedback' THEN
      v_table := 'feedback_ticket';
      v_pred := 't.status IN (''DONE'', ''REFUSED'', ''DUPLICATE'') AND coalesce(t.closed_at, t.updated_at) < $1';
    WHEN 'audit_log' THEN
      -- An entry that an « annulation » points to stays as long as that annulation does.
      v_table := 'audit_log';
      v_pred := 't.at < $1 AND t.action = ANY($3) AND NOT EXISTS (SELECT 1 FROM "app"."audit_log" z WHERE z.reverts_id = t.id)';
    WHEN 'data_change' THEN
      v_table := 'data_change'; v_pred := 't.at < $1 AND t.table_name = ANY($3)';
    ELSE
      RAISE EXCEPTION 'retention_run: unknown kind %', p_kind;
  END CASE;

  IF p_mode = 'count' THEN
    RETURN QUERY EXECUTE format('SELECT count(*)::bigint, coalesce(sum(%s), 0)::bigint, NULL::jsonb FROM "app".%I t WHERE %s',
                                v_size, v_table, v_pred)
      USING p_cutoff, p_batch, p_keys, v_archive;
    RETURN;
  END IF;

  PERFORM set_config('episoft.purge', 'on', true);

  IF p_kind = 'feedback' THEN
    EXECUTE format('SELECT coalesce(array_agg(s.id), ''{}'') FROM (SELECT t.id FROM "app".feedback_ticket t WHERE %s LIMIT $2) s', v_pred)
      INTO v_ids USING p_cutoff, p_batch, p_keys, v_archive;
    WITH c AS (
      DELETE FROM "app".feedback_comment x WHERE x.ticket_id = ANY (v_ids)
      RETURNING jsonb_build_object('table', 'feedback_comment', 'row', to_jsonb(x.*)) AS r),
    d AS (
      DELETE FROM "app".feedback_ticket x WHERE x.id = ANY (v_ids)
      RETURNING jsonb_build_object('table', 'feedback_ticket', 'row', to_jsonb(x.*)) AS r)
    SELECT (SELECT count(*) FROM d),
           CASE WHEN v_archive THEN (SELECT jsonb_agg(u.r) FROM (SELECT d.r FROM d UNION ALL SELECT c.r FROM c) u) END
      INTO v_n, v_removed;
  ELSIF v_op = 'update' THEN
    EXECUTE format($q$
      WITH s AS (SELECT t.ctid AS c, jsonb_build_object('table', %2$L, 'row', to_jsonb(t.*)) AS r
                   FROM "app".%1$I t WHERE %3$s LIMIT $2),
           u AS (UPDATE "app".%1$I x SET %4$s FROM s WHERE x.ctid = s.c RETURNING 1)
      SELECT (SELECT count(*) FROM u)::bigint, CASE WHEN $4 THEN (SELECT jsonb_agg(s.r) FROM s) END$q$,
      v_table, v_table, v_pred, v_set)
      INTO v_n, v_removed USING p_cutoff, p_batch, p_keys, v_archive;
  ELSE
    -- Session tokens and the like are never copied into an archive.
    IF p_kind IN ('session', 'password_reset_token', 'till_pin_attempt') THEN v_archive := false; END IF;
    EXECUTE format($q$
      WITH d AS (
        DELETE FROM "app".%1$I x
         WHERE x.ctid IN (SELECT t.ctid FROM "app".%1$I t WHERE %2$s LIMIT $2)
        RETURNING jsonb_build_object('table', %1$L, 'row', to_jsonb(x.*)) AS r)
      SELECT count(*)::bigint, CASE WHEN $4 THEN jsonb_agg(d.r) END FROM d$q$,
      v_table, v_pred)
      INTO v_n, v_removed USING p_cutoff, p_batch, p_keys, v_archive;
  END IF;

  PERFORM set_config('episoft.purge', 'off', true);
  RETURN QUERY SELECT v_n, 0::bigint, v_removed;
END;
$$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "app"."retention_run"(text, timestamptz, integer, text, text[]) FROM PUBLIC;
--> statement-breakpoint
SELECT app.attach_change_capture();
