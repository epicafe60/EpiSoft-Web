-- R-CAG-03: the cagnotte balance of a household is the sum of its wallet entries.
CREATE VIEW "app"."household_balance" AS
SELECT h.id AS household_id,
       COALESCE(SUM(w.amount), 0)::numeric(12,2) AS balance,
       MAX(w.created_at) AS last_entry_at
  FROM "app"."household" h
  LEFT JOIN "app"."wallet_entry" w ON w.household_id = h.id
 GROUP BY h.id;
