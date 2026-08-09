"use client";

import Link from "next/link";
import {
  AgentFrameworkGroups,
  AgentStarterPrompts,
} from "@/components/agent/connect-agent-panel";
import { Button } from "@/components/ui/button";
import { McpEndpointCard } from "./api-keys/mcp-endpoint-card";
import { SectionHeader, SettingsCard } from "./section";

export function AgentsSection(): React.ReactElement {
  return (
    <>
      <SectionHeader
        action={
          <Button asChild variant="outline">
            <Link href="/settings/api-keys">Manage API keys</Link>
          </Button>
        }
        description="Point an MCP client at this organization so it can build and run workflows for you. Clients sign in through the browser, so no API key is needed to connect."
        title="Agents"
      />

      <McpEndpointCard />

      <SettingsCard
        description="Pick your client and run the command it shows."
        title="Client setup"
      >
        <AgentFrameworkGroups />
      </SettingsCard>

      <SettingsCard
        description="Copy one of these into your agent to check the connection."
        title="Starter prompts"
      >
        <AgentStarterPrompts />
      </SettingsCard>
    </>
  );
}
