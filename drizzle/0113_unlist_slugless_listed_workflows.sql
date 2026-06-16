-- Unlist any workflow flagged as listed but missing a slug. A listed workflow
-- with a null slug is discoverable in the marketplace catalog yet uncallable:
-- external agents invoke a listing by slug at /api/mcp/workflows/<slug>/call,
-- and there is no slug to address. The save-time gate now refuses to create or
-- keep such rows; this one-time cleanup unlists any that predate the gate.
-- Data-only migration: no schema change.
UPDATE "workflows"
SET "is_listed" = false
WHERE "is_listed" = true AND "listed_slug" IS NULL;
