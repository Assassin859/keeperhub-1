import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { member } from "@/lib/db/schema";

type WorkflowAccessSubject = {
  userId: string | null;
  organizationId: string | null;
  authMethod?: "api-key" | "internal" | "oauth" | "session" | "webhook";
};

type WorkflowAccessWorkflow = {
  id?: string;
  userId: string;
  organizationId: string | null;
  isAnonymous: boolean;
};

export type WorkflowAccess = {
  isCreatorWithCurrentAccess: boolean;
  isSameOrg: boolean;
  hasFullAccess: boolean;
};

async function isUserMemberOfOrganization(
  userId: string,
  organizationId: string
): Promise<boolean> {
  const [membership] = await db
    .select({ id: member.id })
    .from(member)
    .where(
      and(eq(member.userId, userId), eq(member.organizationId, organizationId))
    )
    .limit(1);

  return membership !== undefined && membership !== null;
}

export async function getWorkflowAccess(
  workflow: WorkflowAccessWorkflow,
  subject: WorkflowAccessSubject
): Promise<WorkflowAccess> {
  const userId = subject.userId;
  const isCreator = userId !== null && userId === workflow.userId;
  const hasSameOrgContext =
    !workflow.isAnonymous &&
    workflow.organizationId !== null &&
    subject.organizationId === workflow.organizationId;
  const isAnonymousCreator = workflow.isAnonymous && isCreator;

  let currentMembership: boolean | null = null;
  const hasCurrentMembership = async (): Promise<boolean> => {
    if (
      workflow.isAnonymous ||
      workflow.organizationId === null ||
      userId === null
    ) {
      return false;
    }
    currentMembership ??= await isUserMemberOfOrganization(
      userId,
      workflow.organizationId
    );
    return currentMembership;
  };

  const isSameOrg =
    hasSameOrgContext &&
    (subject.authMethod === "api-key" && userId !== null
      ? await hasCurrentMembership()
      : true);
  const isOrgWorkflowCreatorWithMembership =
    !workflow.isAnonymous &&
    isCreator &&
    !isSameOrg &&
    workflow.organizationId !== null &&
    userId !== null &&
    (await hasCurrentMembership());

  const isCreatorWithCurrentAccess =
    isAnonymousCreator ||
    (isCreator && isSameOrg) ||
    isOrgWorkflowCreatorWithMembership;

  return {
    isCreatorWithCurrentAccess,
    isSameOrg,
    hasFullAccess: isCreatorWithCurrentAccess || isSameOrg,
  };
}
