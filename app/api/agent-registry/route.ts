import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { agentRegistrations } from "@/lib/db/schema";
import { ErrorCategory, logSystemError } from "@/lib/logging";

// Must match TARGET_CHAIN_ID and IDENTITY_REGISTRY_ADDRESS in
// scripts/register-agent.ts. The endpoint serves the public ERC-8004
// discovery payload and must return the canonical mainnet registration
// regardless of how many other (chain, registry) rows exist in the table.
const MAINNET_CHAIN_ID = 1;
const IDENTITY_REGISTRY_ADDRESS = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";

export async function GET(_request: Request): Promise<NextResponse> {
  try {
    const rows = await db
      .select()
      .from(agentRegistrations)
      .where(
        and(
          eq(agentRegistrations.chainId, MAINNET_CHAIN_ID),
          eq(agentRegistrations.registryAddress, IDENTITY_REGISTRY_ADDRESS)
        )
      )
      .limit(1);
    const registration = rows[0] ?? null;

    const registrationJson = {
      type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
      name: "KeeperHub",
      description:
        "Web3 workflow automation platform. Build and deploy on-chain automations through a visual builder. Workflows are callable by AI agents via MCP.",
      image: "https://app.keeperhub.com/keeperhub_logo.png",
      services: [
        { name: "mcp", endpoint: "https://app.keeperhub.com/mcp" },
        { name: "web", endpoint: "https://app.keeperhub.com" },
        { name: "ens", endpoint: "keeperhub.eth" },
      ],
      x402Support: true,
      active: true,
      registrations: registration
        ? [
            {
              agentId: registration.agentId,
              agentRegistry: `eip155:1:${registration.registryAddress}`,
            },
          ]
        : [],
    };

    return NextResponse.json(registrationJson, {
      headers: {
        "Cache-Control": "public, max-age=300, stale-while-revalidate=600",
      },
    });
  } catch (err) {
    logSystemError(
      ErrorCategory.DATABASE,
      "[agent-registry] Failed to load registration",
      err,
      { endpoint: "/api/agent-registry" }
    );
    return NextResponse.json(
      { error: "Failed to load agent registry" },
      { status: 500 }
    );
  }
}
