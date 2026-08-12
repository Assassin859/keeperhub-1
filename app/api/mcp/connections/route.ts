import { NextResponse } from "next/server";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import {
  getMemberScopeCeiling,
  getOrgMaxScope,
  listConnections,
} from "@/lib/mcp/connections";
import { resolveCaller, roleOf } from "./_lib/guard";

/**
 * GET /api/mcp/connections
 *
 * The MCP clients connected to this organization. Admins and owners see every
 * connection; a member sees only the ones they consented to, because the
 * filter is applied here rather than left to the client.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const caller = await resolveCaller(request);
  if (!caller.ok) {
    return NextResponse.json(
      { error: caller.error },
      { status: caller.status }
    );
  }

  try {
    const connections = await listConnections(
      caller.organizationId,
      caller.isAdmin ? undefined : caller.userId
    );

    // Grouped by person, because access is a property of the person while a
    // session is a thing you revoke. The newest session leads each group.
    const byUser = new Map<string, (typeof groups)[number]>();
    const groups: {
      userId: string;
      userName: string;
      userEmail: string;
      maxScope: string | null;
      /** An admin may not set an owner's access, so the UI must know. */
      canEdit: boolean;
      sessions: typeof connections;
    }[] = [];
    for (const connection of connections) {
      let group = byUser.get(connection.userId);
      if (!group) {
        const targetRole = await roleOf(
          connection.userId,
          caller.organizationId
        );
        group = {
          canEdit:
            caller.isAdmin &&
            (targetRole !== "owner" || caller.role === "owner"),
          maxScope: await getMemberScopeCeiling(
            connection.userId,
            caller.organizationId
          ),
          sessions: [],
          userEmail: connection.userEmail,
          userId: connection.userId,
          userName: connection.userName,
        };
        byUser.set(connection.userId, group);
        groups.push(group);
      }
      group.sessions.push(connection);
    }

    return NextResponse.json({
      canManage: caller.isAdmin,
      maxScope: await getOrgMaxScope(caller.organizationId),
      users: groups,
    });
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "[McpConnections] Failed to list connections",
      error,
      { endpoint: "/api/mcp/connections", operation: "list" }
    );
    return NextResponse.json(
      { error: "Could not load connections" },
      { status: 500 }
    );
  }
}
