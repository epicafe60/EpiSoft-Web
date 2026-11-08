-- Audit KV2, D01: separates the owner of the schema from the role the application runs with.
--
-- Before: episoft_app owns the database, the schema app, every table, function and trigger, and
-- the application connects with it. A flaw in the application (an SQL injection, a mistake in a
-- query built by hand) could then drop a table, remove the triggers of the audit (ADR 0008) or
-- rewrite the journals.
-- After: episoft_owner owns everything and only applies the migrations; episoft_app reads and
-- writes the data, and only adds to the journals (audit_log, data_change). episoft_ro unchanged.
--
-- Run ONCE, as the superuser, after a backup, the application stopped:
--   sudo -u postgres psql -d episoft -v ON_ERROR_STOP=1 -v owner_pw="<new password>" -f split-roles.sql
-- Safe to run again (it creates nothing twice). See docs/maintenance.md, « Rôles de la base ».
-- The test suite of the API replays this file on a copy of the current layout before each run.

\set ON_ERROR_STOP on
BEGIN;

SELECT NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'episoft_owner') AS create_owner \gset
\if :create_owner
  CREATE ROLE episoft_owner LOGIN;
\endif
ALTER ROLE episoft_owner PASSWORD :'owner_pw';
ALTER ROLE episoft_owner SET search_path = app, public;

-- Everything episoft_app owns in this database (and the database itself) moves to the owner.
REASSIGN OWNED BY episoft_app TO episoft_owner;

-- The application: the data, nothing on the structure.
GRANT CONNECT ON DATABASE :"DBNAME" TO episoft_app, episoft_owner;
REVOKE CREATE ON SCHEMA app FROM episoft_app;
GRANT USAGE ON SCHEMA app TO episoft_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app TO episoft_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA app TO episoft_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO episoft_app;
-- The tables of the next migrations (created by the owner) get the same rights.
ALTER DEFAULT PRIVILEGES FOR ROLE episoft_owner IN SCHEMA app
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO episoft_app;
ALTER DEFAULT PRIVILEGES FOR ROLE episoft_owner IN SCHEMA app
  GRANT USAGE, SELECT ON SEQUENCES TO episoft_app;
ALTER DEFAULT PRIVILEGES FOR ROLE episoft_owner IN SCHEMA app
  GRANT EXECUTE ON FUNCTIONS TO episoft_app;

-- The journals only grow; the RGPD anonymisation goes through app.scrub_member(), which runs
-- with the rights of the owner (migration 0026).
REVOKE UPDATE, DELETE, TRUNCATE ON app.audit_log, app.data_change FROM episoft_app;
-- Which migrations ran is the business of the owner only.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON app.__drizzle_migrations FROM episoft_app;

-- The read-only role keeps reading every table, the next ones too.
GRANT USAGE ON SCHEMA app TO episoft_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA app TO episoft_ro;
ALTER DEFAULT PRIVILEGES FOR ROLE episoft_owner IN SCHEMA app GRANT SELECT ON TABLES TO episoft_ro;

COMMIT;

-- What the application role can do now (shown for the record).
SELECT r.rolname,
       has_schema_privilege(r.rolname, 'app', 'CREATE') AS can_create_in_app,
       has_table_privilege(r.rolname, 'app.member', 'INSERT') AS can_write_members,
       has_table_privilege(r.rolname, 'app.audit_log', 'UPDATE') AS can_rewrite_journal
  FROM pg_roles r WHERE r.rolname IN ('episoft_app', 'episoft_owner', 'episoft_ro');
