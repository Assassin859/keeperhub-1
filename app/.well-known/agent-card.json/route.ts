// A2A Agent Card (https://a2a-protocol.org). Referenced from the ERC-8004
// agent registry as the "A2A" service so 8004scan can discover capabilities
// without an MCP handshake.

const TRAILING_SLASH = /\/$/;

function deriveBaseUrl(request: Request): string {
  const envUrl = process.env.NEXT_PUBLIC_APP_URL ?? process.env.BETTER_AUTH_URL;
  if (envUrl) {
    return envUrl.replace(TRAILING_SLASH, "");
  }
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}

export function GET(request: Request): Response {
  const baseUrl = deriveBaseUrl(request);
  const card = {
    name: "KeeperHub",
    description:
      "Web3 workflow automation platform. Build and deploy on-chain automations through a visual builder. Workflows are callable by AI agents via MCP and x402 micropayments.",
    url: baseUrl,
    version: "1.0.0",
    provider: {
      organization: "KeeperHub",
      url: baseUrl,
    },
    capabilities: {
      streaming: false,
      pushNotifications: false,
      stateTransitionHistory: false,
    },
    defaultInputModes: ["text", "application/json"],
    defaultOutputModes: ["application/json"],
    authentication: { schemes: ["bearer"] },
    skills: [
      {
        id: "workflow_discovery",
        name: "Workflow Discovery",
        description:
          "Search and list agent-callable workflows in the KeeperHub catalog by keyword, plugin, or chain.",
        tags: ["discovery", "workflow", "catalog", "search"],
      },
      {
        id: "workflow_invocation",
        name: "Workflow Invocation",
        description:
          "Invoke a listed workflow with structured inputs. Paid workflows settle via x402 micropayments on Base.",
        tags: ["execution", "x402", "payments", "workflow"],
      },
      {
        id: "ai_workflow_generation",
        name: "AI Workflow Generation",
        description:
          "Generate a new workflow from a natural-language description, including triggers, actions, and parameters.",
        tags: ["generation", "ai", "workflow", "automation"],
      },
      {
        id: "protocol_actions",
        name: "Protocol Actions",
        description:
          "Search and execute Web3 protocol actions (DeFi, governance, NFT, bridging) across supported chains.",
        tags: ["defi", "web3", "protocol", "onchain"],
      },
      {
        id: "onchain_execution",
        name: "On-chain Execution",
        description:
          "Execute token transfers, contract calls, and conditional check-and-execute transactions across supported chains.",
        tags: ["transfer", "contract", "execution", "onchain"],
      },
      {
        id: "templates",
        name: "Workflow Templates",
        description:
          "Browse the template gallery and deploy pre-built workflows with parameter overrides.",
        tags: ["templates", "deploy", "workflow"],
      },
      {
        id: "execution_monitoring",
        name: "Execution Monitoring",
        description:
          "Inspect workflow run status and logs for debugging and audit trails.",
        tags: ["observability", "logs", "monitoring"],
      },
    ],
  };

  return Response.json(card, {
    headers: {
      "Cache-Control": "public, max-age=300, stale-while-revalidate=600",
    },
  });
}
