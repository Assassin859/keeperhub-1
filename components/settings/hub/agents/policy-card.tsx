"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SUPPORTED_SCOPES } from "@/lib/mcp/oauth-scopes";
import { SettingsCard } from "../section";
import { scopeLabel } from "./connections-table";

/**
 * An unset ceiling and a ceiling of full access permit exactly the same thing,
 * so the picker offers only the three real levels and an unset one reads as
 * full access. The column stays nullable underneath for organizations that
 * predate the setting.
 */
const UNSET_READS_AS = "mcp:admin";

export function PolicyCard({
  maxScope,
  saving,
  onChange,
}: {
  maxScope: string | null;
  saving: boolean;
  onChange: (scope: string | null) => void;
}): React.ReactElement {
  return (
    <SettingsCard
      description="The most any connected agent may do here. Lowering it narrows the connections that already hold more, so a ceiling applies to the agents it was set for rather than only to the next one."
      title="Maximum access"
    >
      <div className="flex flex-wrap items-center gap-3">
        <Select
          disabled={saving}
          onValueChange={onChange}
          value={maxScope ?? UNSET_READS_AS}
        >
          <SelectTrigger className="w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SUPPORTED_SCOPES.map((scope) => (
              <SelectItem key={scope} value={scope}>
                {scopeLabel(scope)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="text-muted-foreground text-xs">
          Applies to every agent in this organization.
        </span>
      </div>
    </SettingsCard>
  );
}
