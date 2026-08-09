"use client";

import { Building2, Check, ChevronsUpDown } from "lucide-react";
import { useState } from "react";
import {
  Command,
  CommandGroup,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { TruncatedTooltip } from "@/components/ui/truncated-tooltip";
import {
  useOrganization,
  useOrganizations,
} from "@/lib/hooks/use-organization";
import { cn } from "@/lib/utils";

/**
 * The scope selector for the whole hub. It sits at the foot of the rail, the
 * conventional spot for a workspace switcher, and is the only place to change
 * organization inside settings.
 */
export function SettingsOrgPicker(): React.ReactElement {
  const { organization, switchOrganization } = useOrganization();
  const { organizations } = useOrganizations();
  const [open, setOpen] = useState(false);

  if (!organization) {
    return <Skeleton className="h-11 w-full rounded-lg" />;
  }

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <button
          aria-expanded={open}
          aria-label="Switch organization"
          className="flex w-full items-center gap-2.5 rounded-lg border px-2.5 py-2 text-left transition-colors hover:bg-muted"
          data-testid="settings-org-picker"
          type="button"
        >
          <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted">
            <Building2 className="size-3.5" />
          </span>
          <span className="flex min-w-0 flex-col">
            <span className="truncate font-medium text-sm">
              {organization.name}
            </span>
            <span className="text-muted-foreground text-xs">
              Organization
            </span>
          </span>
          <ChevronsUpDown className="ml-auto size-3.5 shrink-0 opacity-60" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[220px] p-0" side="top">
        <Command>
          <CommandList>
            <CommandGroup heading="Switch organization">
              {organizations.map((org) => (
                <CommandItem
                  key={org.id}
                  onSelect={() => {
                    setOpen(false);
                    switchOrganization(org.id);
                  }}
                >
                  <Check
                    className={cn(
                      "mr-1 size-4",
                      organization.id === org.id ? "opacity-100" : "opacity-0"
                    )}
                  />
                  <TruncatedTooltip
                    className="min-w-0 flex-1 text-left"
                    side="right"
                    text={org.name}
                  />
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
