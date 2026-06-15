-- Backfill "<type>.created" audit events for org resources that predate audit
-- logging, so the org activity feed shows a real (server-side, paginated)
-- creation baseline instead of a client-synthesized one. Each row is marked
-- metadata.backfilled = true for transparency, attributed to the resource's
-- creator (the read path resolves actor_user_id -> name/role), and stamped with
-- the resource's own created_at so it sorts as the oldest event for that
-- resource. NOT EXISTS keeps it idempotent: a resource that already has a real
-- ".created" event is skipped, so this never double-counts.
INSERT INTO "security_audit_log"
  (id, actor_user_id, organization_id, auth_method, action, resource_type, resource_id, outcome, metadata, created_at)
SELECT gen_random_uuid()::text, w.user_id, w.organization_id, 'internal', 'workflow.created', 'workflow', w.id, 'succeeded', '{"backfilled": true}'::jsonb, w.created_at
FROM "workflows" w
WHERE w.organization_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "security_audit_log" a
    WHERE a.resource_type = 'workflow' AND a.resource_id = w.id AND a.action = 'workflow.created'
  );
--> statement-breakpoint
INSERT INTO "security_audit_log"
  (id, actor_user_id, organization_id, auth_method, action, resource_type, resource_id, outcome, metadata, created_at)
SELECT gen_random_uuid()::text, p.user_id, p.organization_id, 'internal', 'project.created', 'project', p.id, 'succeeded', '{"backfilled": true}'::jsonb, p.created_at
FROM "projects" p
WHERE p.organization_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "security_audit_log" a
    WHERE a.resource_type = 'project' AND a.resource_id = p.id AND a.action = 'project.created'
  );
--> statement-breakpoint
INSERT INTO "security_audit_log"
  (id, actor_user_id, organization_id, auth_method, action, resource_type, resource_id, outcome, metadata, created_at)
SELECT gen_random_uuid()::text, t.user_id, t.organization_id, 'internal', 'tag.created', 'tag', t.id, 'succeeded', '{"backfilled": true}'::jsonb, t.created_at
FROM "tags" t
WHERE t.organization_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "security_audit_log" a
    WHERE a.resource_type = 'tag' AND a.resource_id = t.id AND a.action = 'tag.created'
  );
--> statement-breakpoint
INSERT INTO "security_audit_log"
  (id, actor_user_id, organization_id, auth_method, action, resource_type, resource_id, outcome, metadata, created_at)
SELECT gen_random_uuid()::text, i.created_by, i.organization_id, 'internal', 'integration.created', 'integration', i.id, 'succeeded', '{"backfilled": true}'::jsonb, i.created_at
FROM "integrations" i
WHERE i.organization_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "security_audit_log" a
    WHERE a.resource_type = 'integration' AND a.resource_id = i.id AND a.action = 'integration.created'
  );
--> statement-breakpoint
INSERT INTO "security_audit_log"
  (id, actor_user_id, organization_id, auth_method, action, resource_type, resource_id, outcome, metadata, created_at)
SELECT gen_random_uuid()::text, k.created_by, k.organization_id, 'internal', 'org_api_key.created', 'org_api_key', k.id, 'succeeded', '{"backfilled": true}'::jsonb, k.created_at
FROM "organization_api_keys" k
WHERE k.organization_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "security_audit_log" a
    WHERE a.resource_type = 'org_api_key' AND a.resource_id = k.id AND a.action = 'org_api_key.created'
  );
