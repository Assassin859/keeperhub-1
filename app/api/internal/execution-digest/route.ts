/**
 * Scheduled workflow execution digest (paid-only email).
 *
 * Sends each opted-in org a daily/weekly summary of its workflow executions and
 * failures to the subscribed members. Authenticated as an internal service
 * (X-Service-Key / HMAC) and invoked by the `execution-digest` k8s CronJob, which
 * runs daily at 14:00 UTC via deploy/scripts/digest-cron.sh. Daily-cadence orgs
 * send every run; weekly-cadence orgs send only on Tuesdays, so weekly digests
 * land Tuesday 14:00 UTC (mid-week mornings see the best engagement).
 */
import { and, eq, inArray } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  member,
  organization,
  users,
  workflowExecutionDigestSettings,
} from "@/lib/db/schema";
import { sendWorkflowExecutionDigestEmail } from "@/lib/email";
import { isFeatureEnabledForOrg } from "@/lib/features/server";
import { authenticateInternalService } from "@/lib/internal-service-auth";
import { ErrorCategory, logSystemError } from "@/lib/logging";
import {
  digestWindowStart,
  getOrgExecutionDigest,
  isDigestDue,
} from "@/lib/notifications/execution-digest";

const FEATURE_ID = "notifications.execution-digest" as const;

type DigestRow = {
  organizationId: string;
  orgName: string;
  cadence: "daily" | "weekly";
  subscriberUserIds: string[];
  lastSentAt: Date | null;
};

type NotifiedOrg = {
  organizationId: string;
  name: string;
  cadence: "daily" | "weekly";
  recipients: number;
};

async function resolveSubscriberEmails(
  organizationId: string,
  subscriberUserIds: string[]
): Promise<string[]> {
  if (subscriberUserIds.length === 0) {
    return [];
  }
  const rows = await db
    .select({ email: users.email })
    .from(member)
    .innerJoin(users, eq(users.id, member.userId))
    .where(
      and(
        eq(member.organizationId, organizationId),
        inArray(member.userId, subscriberUserIds)
      )
    );
  return rows.map((r) => r.email).filter((e): e is string => Boolean(e));
}

async function processOrg(
  row: DigestRow,
  now: Date
): Promise<NotifiedOrg | null> {
  if (!isDigestDue(row.cadence, row.lastSentAt, now)) {
    return null;
  }
  // Re-check plan at send time so a downgraded org stops receiving digests.
  if (!(await isFeatureEnabledForOrg(FEATURE_ID, row.organizationId))) {
    return null;
  }

  const since = digestWindowStart(row.cadence, now);
  const digest = await getOrgExecutionDigest(row.organizationId, since, now);
  if (digest.total === 0) {
    // No activity this window; send nothing and leave lastSentAt so the next
    // run re-evaluates once there is something to report.
    return null;
  }

  const emails = await resolveSubscriberEmails(
    row.organizationId,
    row.subscriberUserIds
  );
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://app.keeperhub.com";

  for (const to of emails) {
    await sendWorkflowExecutionDigestEmail({
      to,
      orgName: row.orgName,
      cadence: row.cadence,
      appUrl,
      stats: {
        total: digest.total,
        success: digest.success,
        error: digest.error,
        transactionCount: digest.transactionCount,
        gasUsedWei: digest.gasUsedWei,
      },
      topFailing: digest.topFailing,
      mostExecuted: digest.mostExecuted,
    });
  }

  await db
    .update(workflowExecutionDigestSettings)
    .set({ lastSentAt: now, updatedAt: now })
    .where(eq(workflowExecutionDigestSettings.organizationId, row.organizationId));

  return {
    organizationId: row.organizationId,
    name: row.orgName,
    cadence: row.cadence,
    recipients: emails.length,
  };
}

export async function GET(request: Request): Promise<NextResponse> {
  const auth = await authenticateInternalService(request);
  if (!auth.authenticated) {
    return NextResponse.json(
      { error: auth.error ?? "Unauthorized" },
      { status: auth.status }
    );
  }

  const now = new Date();
  const notified: NotifiedOrg[] = [];
  let orgsProcessed = 0;
  let skipped = 0;
  let errors = 0;

  try {
    const rows = await db
      .select({
        organizationId: workflowExecutionDigestSettings.organizationId,
        orgName: organization.name,
        cadence: workflowExecutionDigestSettings.cadence,
        subscriberUserIds: workflowExecutionDigestSettings.subscriberUserIds,
        lastSentAt: workflowExecutionDigestSettings.lastSentAt,
      })
      .from(workflowExecutionDigestSettings)
      .innerJoin(
        organization,
        eq(organization.id, workflowExecutionDigestSettings.organizationId)
      )
      .where(eq(workflowExecutionDigestSettings.enabled, true));

    for (const row of rows) {
      orgsProcessed++;
      try {
        const result = await processOrg(row, now);
        if (result) {
          notified.push(result);
        } else {
          skipped++;
        }
      } catch (error) {
        errors++;
        logSystemError(
          ErrorCategory.EXTERNAL_SERVICE,
          "[ExecutionDigest] Failed to process org digest",
          error,
          { organization_id: row.organizationId }
        );
      }
    }

    return NextResponse.json({
      orgsProcessed,
      sent: notified.length,
      skipped,
      errors,
      notified,
    });
  } catch (error) {
    logSystemError(
      ErrorCategory.DATABASE,
      "[ExecutionDigest] Failed to run digest job",
      error,
      { endpoint: "/api/internal/execution-digest", operation: "get" }
    );
    return NextResponse.json(
      { error: "Digest run failed" },
      { status: 500 }
    );
  }
}
