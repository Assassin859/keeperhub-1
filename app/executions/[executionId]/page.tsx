import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { ExecutionShareView } from "@/components/executions/execution-share-view";
import { ExecutionSignInGate } from "@/components/executions/execution-sign-in-gate";
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

  if (access.mode === "signInRequired") {
    return <ExecutionSignInGate />;
  }

  const { execution } = access;

  return (
    <ExecutionShareView
      executionId={executionId}
      initialStatus={execution.status}
      workflowId={execution.workflow.id}
      workflowName={execution.workflow.name}
    />
  );
}
