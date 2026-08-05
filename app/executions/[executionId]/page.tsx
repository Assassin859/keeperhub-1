import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { ExecutionAccessDenied } from "@/components/executions/execution-access-denied";
import { ExecutionShareView } from "@/components/executions/execution-share-view";
import { auth } from "@/lib/auth";
import { isAnonymousUserShape } from "@/lib/auth-anonymous-guard";
import { resolveExecutionViewAccess } from "@/lib/workflow/execution-access";

type ExecutionPageProps = {
  params: Promise<{ executionId: string }>;
};

export default async function ExecutionPage({
  params,
}: ExecutionPageProps): Promise<React.ReactElement> {
  const { executionId } = await params;
  const headerList = await headers();
  const request = new Request(`http://localhost/executions/${executionId}`, {
    headers: headerList,
  });

  const access = await resolveExecutionViewAccess(request, executionId);

  if (access.mode === "notFound") {
    notFound();
  }

  if (access.mode === "accessDenied") {
    return <ExecutionAccessDenied />;
  }

  if (access.mode === "invalidAuth") {
    notFound();
  }

  const session = await auth.api.getSession({ headers: headerList });
  const hasSession = Boolean(
    session?.user && !isAnonymousUserShape(session.user)
  );

  const { execution } = access;

  return (
    <ExecutionShareView
      executionId={executionId}
      hasSession={hasSession}
      initialStatus={execution.status}
      workflowId={execution.workflow.id}
      workflowName={execution.workflow.name}
    />
  );
}
