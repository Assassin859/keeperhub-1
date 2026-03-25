import { CONFIG } from "./config";

/**
 * Execute a workflow via the KeeperHub API endpoint.
 * Used in "process" execution mode where the API handles execution
 * directly without K8s Job isolation.
 */
export async function executeViaApi(params: {
  workflowId: string;
  executionId: string;
  input: Record<string, unknown>;
}): Promise<void> {
  const { workflowId, executionId, input } = params;

  const response = await fetch(
    `${CONFIG.keeperhubApiUrl}/api/workflow/${workflowId}/execute`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Service-Key": CONFIG.keeperhubApiKey,
      },
      body: JSON.stringify({ executionId, input }),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`API call failed: ${response.status} - ${errorText}`);
  }

  const result = (await response.json()) as { executionId: string };
  console.log(`[Executor:API] Execution started: ${result.executionId}`);
}
