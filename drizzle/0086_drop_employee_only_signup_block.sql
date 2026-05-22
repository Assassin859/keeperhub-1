-- Retire the emergency signup whitelist installed in migration 0084.
--
-- The trigger block_user_signup_security_2026_05_21 refused every INSERT on
-- users whose email did not end in @techops.services or @keeperhub.com. It was
-- the stop-gap that kept the platform employee-only while app-layer signup
-- defenses were being built. Those defenses (Cloudflare Turnstile gated on
-- /sign-up/email, per-IP signup rate limit, and the existing email-verification
-- requirement) are now in place, so the trigger can come off and real customer
-- signup can re-open.
--
-- Scope of this migration is intentionally narrow: drop the signup-block
-- trigger and its companion function. Identifiers are explicit. Do NOT
-- broaden to LIKE / wildcards - the sibling trigger
-- block_executions_security_2026_05_21 (migration 0082) is the executions
-- kill-switch and must remain in place until separately retired. The
-- cascade-deactivation triggers from migration 0085 are also unrelated and
-- must remain.
--
-- Pre-flight verification on staging (run after this migration applies):
--   SELECT tgname FROM pg_trigger
--   WHERE tgname LIKE 'block_%' AND NOT tgisinternal;
-- Expected:
--   block_executions_security_2026_05_21  (still present)
-- Should NOT include block_user_signup_security_2026_05_21.

DROP TRIGGER IF EXISTS block_user_signup_security_2026_05_21 ON users;
DROP FUNCTION IF EXISTS public.block_user_signup_security_2026_05_21();
