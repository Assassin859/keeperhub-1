/**
 * Org slugs for the managed clients that get white-glove operational
 * treatment: their per-workflow error series power the managed-client
 * user-error Grafana alerts, and they are part of the post-deploy
 * verification cohort.
 *
 * Kept dependency-free so it can be imported from API routes, the metrics
 * scraper, and scripts without pulling in `server-only` or the metrics pool.
 *
 * Mirrors `local.managed_org_slugs_regex` in the infra Grafana alert config;
 * adding a managed org requires updating both lists.
 */
export const MANAGED_ORG_SLUGS = ["techops-services", "ajna"] as const;

export type ManagedOrgSlug = (typeof MANAGED_ORG_SLUGS)[number];
