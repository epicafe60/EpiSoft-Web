CREATE TABLE "app"."data_change" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "app"."data_change_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"xact" "xid8" DEFAULT pg_current_xact_id() NOT NULL,
	"table_name" text NOT NULL,
	"row_key" jsonb,
	"op" text NOT NULL,
	"old" jsonb,
	"new" jsonb,
	"source" text
);
--> statement-breakpoint
-- Added without a default first: the entries written before keep a null transaction.
ALTER TABLE "app"."audit_log" ADD COLUMN "xact" "xid8";--> statement-breakpoint
ALTER TABLE "app"."audit_log" ALTER COLUMN "xact" SET DEFAULT pg_current_xact_id();--> statement-breakpoint
ALTER TABLE "app"."audit_log" ADD COLUMN "reverts_id" uuid;--> statement-breakpoint
CREATE INDEX "data_change_xact_idx" ON "app"."data_change" USING btree ("xact");--> statement-breakpoint
CREATE INDEX "data_change_row_idx" ON "app"."data_change" USING btree ("table_name","row_key");--> statement-breakpoint
CREATE INDEX "data_change_at_idx" ON "app"."data_change" USING btree ("at");--> statement-breakpoint
ALTER TABLE "app"."audit_log" ADD CONSTRAINT "audit_log_reverts_id_audit_log_id_fk" FOREIGN KEY ("reverts_id") REFERENCES "app"."audit_log"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_xact_idx" ON "app"."audit_log" USING btree ("xact");--> statement-breakpoint
CREATE INDEX "audit_log_reverts_idx" ON "app"."audit_log" USING btree ("reverts_id");--> statement-breakpoint

-- Complete record of the changes (R-ADM-05): every row inserted, changed or deleted in the
-- schema is written to data_change by a trigger, whoever makes the change (the application, a
-- background job, or someone in psql). The application's own journal (audit_log) says who did
-- what; both carry the transaction id, which links an action to the exact rows it changed.

-- The technical journals themselves, and the login sessions (secrets, one write per request).
CREATE FUNCTION "app"."change_capture_excluded"() RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY['audit_log', 'data_change', 'login_log', 'error_log', 'integrity_run', 'backup_run',
               'job_run', 'session', 'password_reset_token', '__drizzle_migrations']
$$;
--> statement-breakpoint

-- Trigger arguments, set by attach_change_capture(): 'pk:<column>' (primary key), 'mask:<column>'
-- (secret: "***"), 'size:<column>' (binary: its size only), 'drop:<column>' (not recorded),
-- 'skip:<column>' (bookkeeping: an update that changes only this column is not recorded).
CREATE FUNCTION "app"."capture_change"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  o jsonb := CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) END;
  n jsonb := CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) END;
  k jsonb;
  arg text;
  col text;
BEGIN
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

-- (Re)attaches the capture to every table of the schema, except the excluded ones. Later
-- migrations that add a table call it again (integrity check AUD-02 finds a table left out).
CREATE FUNCTION "app"."attach_change_capture"() RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  t record;
  args text;
BEGIN
  FOR t IN
    SELECT c.oid, c.relname::text AS name
      FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
     WHERE ns.nspname = 'app' AND c.relkind IN ('r', 'p')
       AND c.relname::text <> ALL ("app"."change_capture_excluded"())
  LOOP
    SELECT string_agg(quote_literal(a.arg), ', ') INTO args FROM (
      SELECT 'pk:' || at.attname AS arg
        FROM pg_index i JOIN pg_attribute at ON at.attrelid = i.indrelid AND at.attnum = ANY (i.indkey)
       WHERE i.indrelid = t.oid AND i.indisprimary
      UNION ALL
      SELECT 'size:' || attname FROM pg_attribute
       WHERE attrelid = t.oid AND attnum > 0 AND NOT attisdropped AND atttypid = 'bytea'::regtype
      UNION ALL
      SELECT 'mask:' || attname FROM pg_attribute
       WHERE attrelid = t.oid AND attnum > 0 AND NOT attisdropped
         AND (attname LIKE '%password%' OR attname LIKE '%token%' OR attname IN ('p256dh', 'auth', 'endpoint'))
      UNION ALL
      SELECT 'drop:' || x FROM unnest(CASE WHEN t.name = 'email_outbox'
                                           THEN ARRAY['html', 'text', 'attachments'] ELSE '{}'::text[] END) x
      UNION ALL
      -- The time of a till's last contact changes at every synchronisation.
      SELECT 'skip:' || x FROM unnest(CASE WHEN t.name = 'pos_device'
                                           THEN ARRAY['last_sync_at'] ELSE '{}'::text[] END) x
    ) a;
    EXECUTE format('DROP TRIGGER IF EXISTS capture_change ON "app".%I', t.name);
    EXECUTE format(
      'CREATE TRIGGER capture_change AFTER INSERT OR UPDATE OR DELETE ON "app".%I FOR EACH ROW EXECUTE FUNCTION "app"."capture_change"(%s)',
      t.name, coalesce(args, ''));
  END LOOP;
END $$;
--> statement-breakpoint
SELECT "app"."attach_change_capture"();
--> statement-breakpoint

-- Both journals are append-only. One exception: anonymising a member (RGPD) blanks the personal
-- values recorded about them, through scrub_member() only.
CREATE OR REPLACE FUNCTION "app"."audit_log_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND current_setting('episoft.scrub', true) = 'on' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "data_change_no_update_delete" BEFORE UPDATE OR DELETE ON "app"."data_change"
  FOR EACH ROW EXECUTE FUNCTION "app"."audit_log_immutable"();
--> statement-breakpoint

-- Replaces every value of a recorded row by « (anonymisé) », except the listed keys.
CREATE FUNCTION "app"."scrub_json"(j jsonb, keep text[]) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN j IS NULL OR jsonb_typeof(j) <> 'object' THEN j ELSE (
    SELECT coalesce(jsonb_object_agg(e.key,
             CASE WHEN e.key = ANY (keep) OR e.value = 'null'::jsonb THEN e.value
                  ELSE '"(anonymisé)"'::jsonb END), '{}'::jsonb)
      FROM jsonb_each(j) e) END
$$;
--> statement-breakpoint

-- R-MBR-08 and R-ADM-05: what the journals recorded about an anonymised member. Called at the end
-- of the anonymisation, in the same transaction (its own changes are blanked too).
CREATE FUNCTION "app"."scrub_member"(mid uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  keep text[] := ARRAY['id', 'number', 'household_id', 'status', 'member_id', 'product_id',
                       'created_at', 'updated_at'];
BEGIN
  PERFORM set_config('episoft.scrub', 'on', true);
  UPDATE "app"."data_change"
     SET old = "app"."scrub_json"(old, keep), new = "app"."scrub_json"(new, keep)
   WHERE (table_name = 'member' AND row_key ->> 'id' = mid::text)
      OR (table_name IN ('product_review', 'product_favorite', 'push_subscription')
          AND coalesce(old ->> 'member_id', new ->> 'member_id') = mid::text);
  UPDATE "app"."audit_log"
     SET before = "app"."scrub_json"(before, keep), after = "app"."scrub_json"(after, keep)
   WHERE entity = 'member' AND entity_id = mid::text;
  PERFORM set_config('episoft.scrub', 'off', true);
END $$;
