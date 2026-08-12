"use client";

import { ChevronRight, Plug, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { relativeTime } from "@/components/settings/session-format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  effectiveScope,
  SUPPORTED_SCOPES,
  scopeExceeds,
} from "@/lib/mcp/oauth-scopes";
import { cn } from "@/lib/utils";
import type {
  McpConnectionRow,
  McpUserGroup,
} from "../hooks/use-mcp-connections";
import { SETTINGS_HEAD_ROW, SETTINGS_ROW } from "../section";

const SKELETON_ROWS = ["a", "b", "c"] as const;

export const SCOPE_LABELS: Record<string, string> = {
  "mcp:admin": "Full access",
  "mcp:read": "Read only",
  "mcp:write": "Read and write",
};

export function scopeLabel(scope: string): string {
  return SCOPE_LABELS[scope] ?? scope;
}

/** An unset ceiling permits everything, which is what full access means. */
const UNSET_READS_AS = "mcp:admin";

function LastUsed({
  session,
}: {
  session: McpConnectionRow;
}): React.ReactElement {
  if (!session.lastUsedAt) {
    return <span className="text-muted-foreground text-xs">Not used yet</span>;
  }
  return (
    <span className="text-muted-foreground text-xs">
      {relativeTime(session.lastUsedAt)}
    </span>
  );
}

/** The most recent moment any of this person's sessions was used. */
function lastUsedAcross(group: McpUserGroup): string | null {
  let latest: string | null = null;
  for (const session of group.sessions) {
    if (session.lastUsedAt && (!latest || session.lastUsedAt > latest)) {
      latest = session.lastUsedAt;
    }
  }
  return latest;
}

function matches(group: McpUserGroup, term: string): boolean {
  if (!term) {
    return true;
  }
  const needle = term.toLowerCase();
  if (
    group.userName.toLowerCase().includes(needle) ||
    group.userEmail.toLowerCase().includes(needle)
  ) {
    return true;
  }
  // A search that names a client keeps the person it belongs to, so the match
  // is still reachable through its group.
  return group.sessions.some(
    (session) =>
      session.clientName.toLowerCase().includes(needle) ||
      session.clientId.toLowerCase().includes(needle)
  );
}

export function ConnectionsTable({
  users,
  canManage,
  maxScope,
  loading,
  busyId,
  onRevoke,
  onScopeChange,
}: {
  users: McpUserGroup[];
  /** Admins and owners set access; everyone may end their own sessions. */
  canManage: boolean;
  /** The organization ceiling. Levels above it are shown but not selectable. */
  maxScope: string | null;
  loading: boolean;
  busyId: string | null;
  onRevoke: (session: McpConnectionRow) => void;
  onScopeChange: (session: McpConnectionRow, scope: string) => void;
}): React.ReactElement {
  const [term, setTerm] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const shown = useMemo(
    () => users.filter((group) => matches(group, term)),
    [users, term]
  );

  const toggle = (userId: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) {
        next.delete(userId);
      } else {
        next.add(userId);
      }
      return next;
    });
  };

  if (!loading && users.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-10 text-center">
        <Plug className="size-6 text-muted-foreground" />
        <span className="font-medium text-sm">No agents connected yet</span>
        <span className="max-w-sm text-muted-foreground text-xs">
          Point a client at the endpoint below and sign in. It appears here the
          moment it connects.
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="relative max-w-xs">
        <Search className="absolute top-2.5 left-2.5 size-3.5 text-muted-foreground" />
        <Input
          className="h-9 pl-8"
          onChange={(e) => setTerm(e.target.value)}
          placeholder="Search people or sessions"
          value={term}
        />
      </div>

      <Table>
        <TableHeader>
          <TableRow className={SETTINGS_HEAD_ROW}>
            <TableHead>Person and sessions</TableHead>
            <TableHead className="w-52">Access</TableHead>
            <TableHead className="w-36">Last used</TableHead>
            <TableHead className="w-24" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading &&
            SKELETON_ROWS.map((key) => (
              <TableRow key={key}>
                <TableCell colSpan={4}>
                  <Skeleton className="h-8 w-full" />
                </TableCell>
              </TableRow>
            ))}

          {!loading && shown.length === 0 && (
            <TableRow>
              <TableCell colSpan={4}>
                <span className="block py-6 text-center text-muted-foreground text-xs">
                  Nothing matches that.
                </span>
              </TableCell>
            </TableRow>
          )}

          {!loading &&
            shown.map((group) => {
              // Access belongs to the person: a cap on one session is shed by
              // reconnecting, since each `mcp add` registers a new client.
              const anchor = group.sessions[0];
              const isOpen = !collapsed.has(group.userId);
              return [
                <TableRow className={SETTINGS_ROW} key={group.userId}>
                  <TableCell>
                    <button
                      aria-expanded={isOpen}
                      className="flex min-w-0 items-center gap-2 text-left"
                      onClick={() => toggle(group.userId)}
                      type="button"
                    >
                      <ChevronRight
                        className={cn(
                          "size-4 shrink-0 text-muted-foreground transition-transform",
                          isOpen && "rotate-90"
                        )}
                      />
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate font-medium">
                          {group.userName || group.userEmail}
                        </span>
                        <span className="truncate text-muted-foreground text-xs">
                          {group.userEmail} ·{" "}
                          {group.sessions.length === 1
                            ? "1 session"
                            : `${group.sessions.length} sessions`}
                        </span>
                      </span>
                    </button>
                  </TableCell>
                  <TableCell>
                    {canManage && group.canEdit && anchor ? (
                      <Select
                        disabled={busyId === anchor.id}
                        onValueChange={(next) => onScopeChange(anchor, next)}
                        value={group.maxScope ?? UNSET_READS_AS}
                      >
                        <SelectTrigger className="h-8 w-48">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {SUPPORTED_SCOPES.map((scope) => {
                            const blocked = scopeExceeds(scope, maxScope);
                            return (
                              <SelectItem
                                disabled={blocked}
                                key={scope}
                                value={scope}
                              >
                                {blocked
                                  ? `${scopeLabel(scope)} (above the organization limit)`
                                  : scopeLabel(scope)}
                              </SelectItem>
                            );
                          })}
                        </SelectContent>
                      </Select>
                    ) : (
                      <span className="text-sm">
                        {scopeLabel(group.maxScope ?? UNSET_READS_AS)}
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    {(() => {
                      const latest = lastUsedAcross(group);
                      return (
                        <span className="text-muted-foreground text-xs">
                          {latest ? relativeTime(latest) : "Not used yet"}
                        </span>
                      );
                    })()}
                  </TableCell>
                  <TableCell />
                </TableRow>,

                ...(isOpen ? group.sessions : []).map((session) => (
                  <TableRow className={SETTINGS_ROW} key={session.id}>
                    <TableCell className="pl-10">
                      <div className="flex min-w-0 flex-col">
                        <span className="truncate text-sm">
                          {session.clientName}
                        </span>
                        {/* Each `mcp add` registers a fresh client, so one tool
                            can hold several sessions under the same name. The
                            client id is what tells them apart, and it is public
                            in OAuth, so a leading fragment is safe to show. */}
                        <span className="text-muted-foreground text-xs">
                          Connected {relativeTime(session.connectedAt)} ·{" "}
                          <span className="font-mono">
                            {session.clientId.slice(0, 8)}
                          </span>
                        </span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <span className="text-muted-foreground text-xs">
                        {scopeLabel(effectiveScope(session.scope))}
                      </span>
                    </TableCell>
                    <TableCell>
                      <LastUsed session={session} />
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        className="h-7 text-xs"
                        disabled={busyId === session.id}
                        onClick={() => onRevoke(session)}
                        size="sm"
                        variant="outline"
                      >
                        Revoke
                      </Button>
                    </TableCell>
                  </TableRow>
                )),
              ];
            })}
        </TableBody>
      </Table>
    </div>
  );
}
