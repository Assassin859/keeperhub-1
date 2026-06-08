"use client";

import { Gem } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useFeature } from "@/hooks/use-features";
import { DIGEST_REQUIRES_SUBSCRIBER_ERROR } from "@/lib/notifications/digest-messages";

type Cadence = "daily" | "weekly";

type DigestMember = {
  userId: string;
  role: string;
  email: string | null;
  name: string | null;
};

type DigestSettingsResponse = {
  enabled: boolean;
  cadence: Cadence;
  subscriberUserIds: string[];
  eligible: boolean;
  members: DigestMember[];
};

type ExecutionDigestSectionProps = {
  organizationId: string;
};

export function ExecutionDigestSection({
  organizationId,
}: ExecutionDigestSectionProps): React.ReactElement {
  const router = useRouter();
  const { enabled: featureEnabled, loading: featureLoading } = useFeature(
    "notifications.execution-digest"
  );

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [cadence, setCadence] = useState<Cadence>("weekly");
  const [subscribers, setSubscribers] = useState<Set<string>>(new Set());
  const [members, setMembers] = useState<DigestMember[]>([]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    fetch(`/api/organizations/${organizationId}/execution-digest`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data: DigestSettingsResponse | null) => {
        if (!(active && data)) {
          return;
        }
        setEnabled(data.enabled);
        setCadence(data.cadence);
        setSubscribers(new Set(data.subscriberUserIds));
        setMembers(data.members);
      })
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [organizationId]);

  const toggleSubscriber = useCallback((userId: string, checked: boolean) => {
    setSubscribers((prev) => {
      const next = new Set(prev);
      if (checked) {
        next.add(userId);
      } else {
        next.delete(userId);
      }
      return next;
    });
  }, []);

  const handleSave = useCallback(async () => {
    if (enabled && subscribers.size === 0) {
      toast.error(DIGEST_REQUIRES_SUBSCRIBER_ERROR);
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(
        `/api/organizations/${organizationId}/execution-digest`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            enabled,
            cadence,
            subscriberUserIds: [...subscribers],
          }),
        }
      );
      if (res.ok) {
        toast.success("Digest settings saved");
      } else if (res.status === 402) {
        toast.error("Execution digests require a paid plan");
      } else {
        toast.error("Could not save settings");
      }
    } catch {
      toast.error("Could not save settings");
    } finally {
      setSaving(false);
    }
  }, [organizationId, enabled, cadence, subscribers]);

  const heading = (
    <h4 className="font-medium text-muted-foreground text-sm">
      Execution digest
    </h4>
  );

  if (!(featureLoading || featureEnabled)) {
    return (
      <div className="space-y-3">
        {heading}
        <div className="flex items-center gap-3 rounded-md border border-border bg-muted/40 p-4">
          <Gem className="size-4 shrink-0 text-accent-foreground" />
          <p className="flex-1 text-muted-foreground text-sm">
            Get a scheduled email summary of your workflow runs: total
            executions, successes, and failures. Available on paid plans.
          </p>
          <Button onClick={() => router.push("/billing")} size="sm">
            Upgrade
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {heading}
      <div className="flex items-center justify-between gap-2">
        <Label className="cursor-pointer text-sm" htmlFor="digest-enabled">
          Email an execution summary on a schedule
        </Label>
        <Switch
          checked={enabled}
          disabled={loading || saving}
          id="digest-enabled"
          onCheckedChange={setEnabled}
        />
      </div>

      <div className="flex items-center justify-between gap-2">
        <Label className="text-sm" htmlFor="digest-cadence">
          Frequency
        </Label>
        <Select
          disabled={!enabled || loading || saving}
          onValueChange={(v) => setCadence(v as Cadence)}
          value={cadence}
        >
          <SelectTrigger className="w-36" id="digest-cadence">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="daily">Daily</SelectItem>
            <SelectItem value="weekly">Weekly</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-2">
        <Label className="text-sm">Subscribers</Label>
        <p className="text-muted-foreground text-xs">
          Choose which owners and admins receive the digest.
        </p>
        {members.length === 0 && !loading && (
          <p className="text-muted-foreground text-xs">
            No owners or admins to notify yet.
          </p>
        )}
        <div className="space-y-2">
          {members.map((m) => (
            <div className="flex items-center gap-2" key={m.userId}>
              <Checkbox
                checked={subscribers.has(m.userId)}
                disabled={!enabled || loading || saving}
                id={`digest-sub-${m.userId}`}
                onCheckedChange={(checked) =>
                  toggleSubscriber(m.userId, checked === true)
                }
              />
              <Label
                className="cursor-pointer text-sm"
                htmlFor={`digest-sub-${m.userId}`}
              >
                {m.email ?? m.name ?? m.userId}
                <span className="ml-1 text-muted-foreground text-xs">
                  ({m.role})
                </span>
              </Label>
            </div>
          ))}
        </div>
      </div>

      <Button
        className="w-full"
        disabled={loading || saving}
        onClick={handleSave}
        size="sm"
        variant="outline"
      >
        {saving ? "Saving..." : "Save changes"}
      </Button>
    </div>
  );
}
