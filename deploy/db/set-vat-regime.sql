-- Deployment of the VAT regime (ADR 0016, TVA): the association is EXEMPT (« exonérée »).
--
-- Migration 0043 gives every ticket and invoice that already exist the regime LIABLE, the default
-- of the application. For an association that was never liable, that label is wrong. This script,
-- run ONCE by the OWNER of the schema (episoft_owner: the history guard lets the owner through,
-- and the change capture records every row it touches), puts the right regime on what exists:
--
--   1. the history of regimes: EXEMPT from the first day of the data, when nobody chose one yet;
--   2. the tickets and the supplier invoices still labelled LIABLE: EXEMPT.
--
-- Nothing is recomputed: the amounts, the VAT lines and the accounting entries already posted are
-- NOT touched (the accountant decides what to do with the VAT entries of the past).
-- Safe to run again: a second run finds nothing left to change.
--
--   sudo bash -c 'set -a; . /etc/episoft/migrate.env; set +a;
--     psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 -X -f deploy/db/set-vat-regime.sql'
--
-- To use another regime (FRANCHISE), change the three values below.

\set ON_ERROR_STOP on
\set regime EXEMPT
BEGIN;
SET LOCAL search_path = app, public;

-- 1. The history: only when nobody chose a regime yet (a choice made in the administration stays).
INSERT INTO vat_regime_change (id, effective_from, regime)
SELECT gen_random_uuid(), d, :'regime'::vat_regime
  FROM (SELECT least(
          (SELECT min((sold_at AT TIME ZONE 'Europe/Paris')::date) FROM sale),
          (SELECT min(date) FROM supplier_invoice),
          (SELECT min(date) FROM member_payment)) AS d) first
 WHERE d IS NOT NULL AND NOT EXISTS (SELECT 1 FROM vat_regime_change);

-- 2. What exists: only the rows still on the default.
WITH s AS (UPDATE sale SET vat_regime = :'regime'::vat_regime
            WHERE vat_regime = 'LIABLE' RETURNING 1),
     i AS (UPDATE supplier_invoice SET vat_regime = :'regime'::vat_regime
            WHERE vat_regime = 'LIABLE' RETURNING 1)
SELECT (SELECT count(*) FROM s) AS tickets_relabelled, (SELECT count(*) FROM i) AS invoices_relabelled;

SELECT effective_from, regime FROM vat_regime_change ORDER BY effective_from;
COMMIT;
