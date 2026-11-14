ALTER TABLE "app"."pos_device" ADD COLUMN "announced_seq" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."pos_device" ADD COLUMN "received_seq" integer DEFAULT 0 NOT NULL;--> statement-breakpoint

-- F5: what a till announces at each contact is bookkeeping, like its last synchronisation: an
-- update that changes only these columns is not recorded in the record of changes.
CREATE OR REPLACE FUNCTION "app"."attach_change_capture"() RETURNS void LANGUAGE plpgsql AS $$
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
                                           THEN ARRAY['last_sync_at', 'last_contact_at', 'pending_ops', 'announced_seq', 'received_seq'] ELSE '{}'::text[] END) x
    ) a;
    EXECUTE format('DROP TRIGGER IF EXISTS capture_change ON "app".%I', t.name);
    EXECUTE format(
      'CREATE TRIGGER capture_change AFTER INSERT OR UPDATE OR DELETE ON "app".%I FOR EACH ROW EXECUTE FUNCTION "app"."capture_change"(%s)',
      t.name, coalesce(args, ''));
  END LOOP;
END $$;
--> statement-breakpoint
SELECT app.attach_change_capture();
