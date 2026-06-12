"use client";

import { ActivityFeed } from "@/components/activity/activity-feed";
import { Overlay } from "@/components/overlays/overlay";
import { useOverlay } from "@/components/overlays/overlay-provider";
import type { Integration, SecurityAuditEvent } from "@/lib/api-client";

/**
 * Activity history (created / updated / deleted) for a single integration,
 * pushed from the integrations manager. Mirrors KeyActivityOverlay: each row
 * identifies the actor; an integration that predates audit logging falls back
 * to a synthesized "added" entry from its creation record.
 */
export function IntegrationActivityOverlay({
  overlayId,
  integration,
}: {
  overlayId: string;
  integration: Integration;
}): React.ReactElement {
  const { pop } = useOverlay();
  const fallback: SecurityAuditEvent[] = [
    {
      id: `fallback-${integration.id}`,
      action: "integration.created",
      resourceType: "integration",
      resourceId: integration.id,
      createdAt: integration.createdAt,
      diff: null,
      metadata: null,
      actor: integration.createdByName
        ? {
            id: "",
            name: integration.createdByName,
            email: integration.createdByEmail ?? null,
            role: integration.createdByRole ?? null,
          }
        : null,
    },
  ];
  return (
    <Overlay
      actions={[{ label: "Done", onClick: pop }]}
      overlayId={overlayId}
      title={`Activity: ${integration.name}`}
    >
      <ActivityFeed
        fallback={fallback}
        params={{ resourceType: "integration", resourceId: integration.id }}
      />
    </Overlay>
  );
}
