import { NextResponse } from "next/server";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import {
  exceedsCeiling,
  getConnection,
  getOrgMaxScope,
  isSupportedScope,
  revokeConnection,
  setMemberScopeCeiling,
} from "@/lib/mcp/connections";
import { bumpScopeEpoch } from "@/lib/mcp/scope-policy";
import { buildAuditMetadata, recordAuditEvent } from "@/lib/security/audit-log";
import { resolveCaller, roleOf } from "../_lib/guard";

type Params = { params: Promise<{ connectionId: string }> };

/**
 * PATCH /api/mcp/connections/{id}
 *
 * Sets what a connection may do. Admins and owners only, bounded by the
 * organization's ceiling. Retires the tokens already issued so the change is
 * not waiting on their hour-long expiry.
 */
export async function PATCH(
  request: Request,
  context: Params
): Promise<NextResponse> {
  const caller = await resolveCaller(request);
  if (!caller.ok) {
    return NextResponse.json(
      { error: caller.error },
      { status: caller.status }
    );
  }
  if (!caller.isAdmin) {
    return NextResponse.json(
      { error: "Only organization admins and owners can change a scope" },
      { status: 403 }
    );
  }

  try {
    const { connectionId } = await context.params;
    const body = (await request.json()) as { scope?: unknown };
    if (!isSupportedScope(body.scope)) {
      return NextResponse.json({ error: "Unknown scope" }, { status: 400 });
    }

    const connection = await getConnection(connectionId, caller.organizationId);
    if (!connection) {
      return NextResponse.json(
        { error: "Connection not found" },
        { status: 404 }
      );
    }
    // An admin does not outrank an owner. Letting one cap the owner's agents
    // would invert the hierarchy, so only an owner may set an owner's access,
    // which in practice means their own.
    const targetRole = await roleOf(connection.userId, caller.organizationId);
    if (targetRole === "owner" && caller.role !== "owner") {
      return NextResponse.json(
        { error: "Only an owner can change an owner's access" },
        { status: 403 }
      );
    }

    const ceiling = await getOrgMaxScope(caller.organizationId);
    if (exceedsCeiling(body.scope, ceiling)) {
      return NextResponse.json(
        { error: `This organization allows at most ${ceiling}` },
        { status: 403 }
      );
    }

    // Capping the person, not the connection: a cap on a connection is shed by
    // reconnecting, since each `mcp add` registers a new client.
    await setMemberScopeCeiling(
      connection.userId,
      caller.organizationId,
      body.scope
    );
    // No epoch bump: the ceiling is applied on every call, so it binds without
    // retiring anyone's tokens. Invalidating them here would force every agent
    // this person runs to reconnect just because their limit moved, which is
    // the opposite of leaving their sessions alone.

    await recordAuditEvent({
      action: "mcp_member_scope.changed",
      actor: {
        apiKeyId: caller.apiKeyId ?? null,
        authMethod: caller.authMethod,
        organizationId: caller.organizationId,
        userId: caller.userId,
      },
      after: { scope: body.scope },
      before: { scope: connection.scope },
      metadata: {
        ...buildAuditMetadata(request),
        clientName: connection.clientName,
        subjectUserId: connection.userId,
      },
      resourceId: connection.userId,
      resourceType: "mcp_member_scope",
    });

    return NextResponse.json({ scope: body.scope, success: true });
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "[McpConnections] Failed to change a connection scope",
      error,
      { endpoint: "/api/mcp/connections/[id]", operation: "patch" }
    );
    return NextResponse.json(
      { error: "Could not change the scope" },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/mcp/connections/{id}
 *
 * Cuts a connection off. A member may do this to their own; admins and owners
 * to any in the organization.
 */
export async function DELETE(
  request: Request,
  context: Params
): Promise<NextResponse> {
  const caller = await resolveCaller(request);
  if (!caller.ok) {
    return NextResponse.json(
      { error: caller.error },
      { status: caller.status }
    );
  }

  try {
    const { connectionId } = await context.params;
    const connection = await getConnection(connectionId, caller.organizationId);
    if (!connection) {
      return NextResponse.json(
        { error: "Connection not found" },
        { status: 404 }
      );
    }
    // A member owns only their own connections. Checked against the row rather
    // than anything the caller supplied.
    if (!(caller.isAdmin || connection.userId === caller.userId)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    await revokeConnection(connectionId, caller.organizationId);
    await bumpScopeEpoch(connection.userId, caller.organizationId);

    await recordAuditEvent({
      action: "mcp_connection.revoked",
      actor: {
        apiKeyId: caller.apiKeyId ?? null,
        authMethod: caller.authMethod,
        organizationId: caller.organizationId,
        userId: caller.userId,
      },
      before: { clientName: connection.clientName, scope: connection.scope },
      metadata: {
        ...buildAuditMetadata(request),
        clientName: connection.clientName,
        subjectUserId: connection.userId,
      },
      resourceId: connectionId,
      resourceType: "mcp_connection",
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "[McpConnections] Failed to revoke a connection",
      error,
      { endpoint: "/api/mcp/connections/[id]", operation: "delete" }
    );
    return NextResponse.json(
      { error: "Could not revoke the connection" },
      { status: 500 }
    );
  }
}
