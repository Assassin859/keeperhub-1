"use client";

import { Plus } from "lucide-react";
import { useState } from "react";
import { EditConnectionOverlay } from "@/components/overlays/edit-connection-overlay";
import { useOverlay } from "@/components/overlays/overlay-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AddConnectionPanel } from "./add-connection-panel";
import { ConnectionsTable } from "./connections/connections-table";
import { useConnections } from "./hooks/use-connections";
import { EmptyState, SectionHeader, SettingsCard } from "./section";
import { RowsSkeleton } from "./skeletons";
import { useSettingsContext } from "./settings-context";

export function ConnectionsSection(): React.ReactElement {
  const { push } = useOverlay();
  const { refreshAll, isAdmin } = useSettingsContext();
  const [filter, setFilter] = useState("");
  const [adding, setAdding] = useState(false);
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
            onEdit={(integration) =>
              push(EditConnectionOverlay, {
                integration,
                onDelete: () => {
                  refetch();
                  refreshAll();
                },
                onSuccess: () => {
                  refetch();
                  refreshAll();
                },
              })
            }
            onRemove={remove}
          />
        )}
      </SettingsCard>
    </>
  );
}
