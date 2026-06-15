-- Make security_audit_log tamper-evident: rows are append-only.
--
-- A BEFORE trigger blocks every UPDATE, and blocks DELETE of any row still
-- inside the retention window. This stops an admin (or a compromised
-- application credential) from editing or deleting recent forensic records to
-- cover tracks, while still letting the retention job purge rows that have
-- aged out past the window. The window here MUST stay in sync with
-- AUDIT_RETENTION_DAYS in lib/security/audit-retention.ts.
CREATE OR REPLACE FUNCTION security_audit_log_append_only()
RETURNS trigger AS $$
BEGIN
  IF (TG_OP = 'UPDATE') THEN
    RAISE EXCEPTION 'security_audit_log is append-only: updates are not permitted';
  END IF;
  IF (TG_OP = 'DELETE') THEN
    IF (OLD.created_at > now() - interval '730 days') THEN
      RAISE EXCEPTION 'security_audit_log is append-only: rows within the retention window cannot be deleted';
    END IF;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS security_audit_log_append_only ON "security_audit_log";
--> statement-breakpoint
CREATE TRIGGER security_audit_log_append_only
BEFORE UPDATE OR DELETE ON "security_audit_log"
FOR EACH ROW EXECUTE FUNCTION security_audit_log_append_only();
