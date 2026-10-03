#!/bin/bash
# Runs ONCE, only when the data folder is empty (first start of the container).
# Creates the EpiSoft-Web database, its schema and two roles:
#   episoft_app : owner, used by the application (read/write)
#   episoft_ro  : read-only, for reports / exports / tools
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -v app_pw="$EPISOFT_APP_PASSWORD" -v ro_pw="$EPISOFT_RO_PASSWORD" <<'SQL'
CREATE ROLE episoft_app LOGIN PASSWORD :'app_pw';
CREATE ROLE episoft_ro  LOGIN PASSWORD :'ro_pw';
CREATE DATABASE episoft OWNER episoft_app ENCODING 'UTF8' LC_COLLATE 'C.UTF-8' LC_CTYPE 'C.UTF-8' TEMPLATE template0;
REVOKE ALL ON DATABASE episoft FROM PUBLIC;
GRANT CONNECT ON DATABASE episoft TO episoft_app, episoft_ro;
SQL

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname episoft <<'SQL'
REVOKE ALL ON SCHEMA public FROM PUBLIC;
CREATE SCHEMA app AUTHORIZATION episoft_app;
GRANT USAGE ON SCHEMA app TO episoft_ro;
ALTER DEFAULT PRIVILEGES FOR ROLE episoft_app IN SCHEMA app GRANT SELECT ON TABLES TO episoft_ro;
ALTER ROLE episoft_app SET search_path = app, public;
ALTER ROLE episoft_ro  SET search_path = app, public;
ALTER ROLE episoft_ro  SET default_transaction_read_only = on;
SQL
