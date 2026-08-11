"use client";

import { Plus } from "lucide-react";
import { useState } from "react";
import { EditConnectionForm } from "@/components/overlays/edit-connection-overlay";
import type { Integration } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AddConnectionPanel } from "./add-connection-panel";
import { ConnectionsTable } from "./connections/connections-table";
import { useConnections } from "./hooks/use-connections";
import { createdFallback } from "@/lib/activity/created-fallback";
import { ActivityPanel } from "./activity-panel";
import { EmptyState, SectionHeader, SettingsCard } from "./section";
import { TableSkeleton } from "./skeletons";
import { useSettingsContext } from "./settings-context";

export function ConnectionsSection(): React.ReactElement {
  const { refreshAll } = useSettingsContext();
  const [filter, setFilter] = useState("");
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Integration | null>(null);
  const [activityFor, setActivityFor] = useState<Integration | null>(null);
  const { connections, loading, refetch, remove } = useConnections(filter);

  return (
    <>
      <SectionHeader
        action={
          <Button onClick={() => setAdding((v) => !v)}>
            <Plus className="size-4" />
            Add connection
          </Button>
        }
        description="Credentials your workflows reuse: Discord, SendGrid, databases, webhooks and more."
        title="Connections"
      />

      {adding && (
        <AddConnectionPanel
          onDone={() => {
            setAdding(false);
            refreshAll();
          }}
        />
      )}

      {editing && (
        <SettingsCard
          description="Update the credentials KeeperHub uses for this service."
          title={`Edit ${editing.name}`}
        >
          <EditConnectionForm
            inline
            integration={editing}
            onCancel={() => setEditing(null)}
            onDelete={() => {
              setEditing(null);
              refetch();
              refreshAll();
            }}
            onSuccess={() => {
              setEditing(null);
              refetch();
              refreshAll();
            }}
          />
        </SettingsCard>
      )}

      <SettingsCard
        action={
          <Input
            className="h-8 w-48"
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Search connections"
            value={filter}
          />
        }
        bodyClassName="p-2"
        title="Configured connections"
      >
        {loading && <TableSkeleton columns={3} leading rows={2} />}
        {!loading && connections.length === 0 && (
          <EmptyState>
            No connections yet. Add one to reuse its credentials across
            workflows.
          </EmptyState>
        )}
        {!loading && connections.length > 0 && (
          <ConnectionsTable
            canManage
            connections={connections}
            onEdit={setEditing}
            onRemove={remove}
            onShowActivity={setActivityFor}
          />
        )}
      </SettingsCard>

      {activityFor && (
        <ActivityPanel
          fallback={[
            createdFallback({
              createdAt: activityFor.createdAt,
              creator: {
                email: activityFor.createdByEmail,
                name: activityFor.createdByName,
                role: activityFor.createdByRole,
              },
              resourceId: activityFor.id,
              resourceName: activityFor.name,
              resourceType: "integration",
            }),
          ]}
          onClose={() => setActivityFor(null)}
          params={{
            limit: 5,
            resourceId: activityFor.id,
            resourceType: "integration",
          }}
          title={`Activity: ${activityFor.name}`}
        />
      )}
    </>
  );
}
