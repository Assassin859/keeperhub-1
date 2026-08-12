import { NextResponse } from "next/server";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import {
  connectionsAboveCeiling,
  getOrgMaxScope,
  isSupportedScope,
  setMemberScopeCeiling,
  setOrgMaxScope,
} from "@/lib/mcp/connections";
import { buildAuditMetadata, recordAuditEvent } from "@/lib/security/audit-log";
import { resolveCaller } from "../connections/_lib/guard";

/**
 * PUT /api/mcp/policy
 *
 * The most any MCP connection in this organization may hold. Lowering it
 * narrows the connections that already exceed it, because a ceiling that only
 * applied to future consent would leave the very connections it was set to
 * rein in untouched.
 */
export async function PUT(request: Request): Promise<NextResponse> {
  const caller = await resolveCaller(request);
  if (!caller.ok) {
    return NextResponse.json(
      { error: caller.error },
      { status: caller.status }
    );
  }
  if (!caller.isAdmin) {
    return NextResponse.json(
      { error: "Only organization admins and owners can set this" },
      { status: 403 }
    );
  }

  try {
    const body = (await request.json()) as { maxScope?: unknown };
    const next =
      body.maxScope === null || body.maxScope === undefined
        ? null
        : body.maxScope;
    if (next !== null && !isSupportedScope(next)) {
      return NextResponse.json({ error: "Unknown scope" }, { status: 400 });
    }

    const before = await getOrgMaxScope(caller.organizationId);
    const ceiling = next;
    const narrowed = ceiling
      ? await connectionsAboveCeiling(caller.organizationId, ceiling)
      : [];

    await setOrgMaxScope(caller.organizationId, ceiling);

    for (const connection of narrowed) {
      if (!ceiling) {
        break;
      }
      await setMemberScopeCeiling(
        connection.userId,
        caller.organizationId,
        ceiling
      );
      await recordAuditEvent({
        action: "mcp_connection.scope_changed",
        actor: {
          apiKeyId: caller.apiKeyId ?? null,
          authMethod: caller.authMethod,
          organizationId: caller.organizationId,
          userId: caller.userId,
        },
        after: { scope: next },
        before: { scope: connection.scope },
        metadata: {
          ...buildAuditMetadata(request),
          clientName: connection.clientName,
          reason: "organization ceiling lowered",
          subjectUserId: connection.userId,
        },
        resourceId: connection.id,
        resourceType: "mcp_connection",
      });
    }

    await recordAuditEvent({
      action: "mcp_policy.updated",
      actor: {
        apiKeyId: caller.apiKeyId ?? null,
        authMethod: caller.authMethod,
        organizationId: caller.organizationId,
        userId: caller.userId,
      },
      after: { maxScope: next },
      before: { maxScope: before },
      metadata: {
        ...buildAuditMetadata(request),
        narrowedConnections: narrowed.length,
      },
      resourceId: caller.organizationId,
      resourceType: "mcp_policy",
    });

    return NextResponse.json({
      maxScope: next,
      narrowed: narrowed.length,
      success: true,
    });
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "[McpPolicy] Failed to set the connection ceiling",
      error,
      { endpoint: "/api/mcp/policy", operation: "put" }
    );
    return NextResponse.json(
      { error: "Could not save the policy" },
      { status: 500 }
    );
  }
}
