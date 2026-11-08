-- Audit KV2, D01: the application role may lose the right to change the journals (audit_log,
-- data_change: grantRuntimeRole revokes UPDATE and DELETE). The RGPD anonymisation still has to
-- blank what they recorded about a member (R-MBR-08): scrub_member() runs with the rights of its
-- owner, the migration role, and only does that. Its search_path is fixed, so that no object of
-- another schema can be slipped in.
ALTER FUNCTION "app"."scrub_member"(uuid) SECURITY DEFINER SET search_path = pg_catalog, pg_temp;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION "app"."scrub_member"(uuid) FROM PUBLIC;
