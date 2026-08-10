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
import { EmptyState, SectionHeader, SettingsCard } from "./section";
import { RowsSkeleton } from "./skeletons";
import { useSettingsContext } from "./settings-context";

export function ConnectionsSection(): React.ReactElement {
  const { refreshAll, isAdmin } = useSettingsContext();
  const [filter, setFilter] = useState("");
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Integration | null>(null);
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
        {loading && <RowsSkeleton rows={3} />}
        {!loading && connections.length === 0 && (
          <EmptyState>
            No connections yet. Add one to reuse its credentials across
            workflows.
          </EmptyState>
        )}
        {!loading && connections.length > 0 && (
          <ConnectionsTable
            canManage={isAdmin}
            connections={connections}
            onEdit={setEditing}
            onRemove={remove}
          />
        )}
      </SettingsCard>
    </>
  );
}
