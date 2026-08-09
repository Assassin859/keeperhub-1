"use client";

import { McpEndpointCard } from "./api-keys/mcp-endpoint-card";
import { KeysCard } from "./api-keys/keys-card";
import { SectionHeader } from "./section";
import { useSettingsContext } from "./settings-context";

const ORG_READ_ONLY =
  "Only organization admins or owners can create or revoke these keys.";

export function ApiKeysSection(): React.ReactElement {
  const { isAdmin } = useSettingsContext();

  return (
    <>
      <SectionHeader
        description="Keys let scripts, agents and CI call the KeeperHub API on this organization's behalf."
        title="API keys"
      />

      <McpEndpointCard />

      <KeysCard
        activity={{ resourceType: "org_api_key", title: "Organisation key activity" }}
        canManage={isAdmin}
        description="Shared by the whole organization. Admins and owners can mint and revoke them."
        keyType="organisation"
        listEndpoint="/api/keys"
        readOnlyReason={ORG_READ_ONLY}
        showCreator
        title="Organisation keys"
      />

      <KeysCard
        activity={isAdmin ? { resourceType: "api_key", title: "User key activity" } : null}
        canManage
        description="Personal to your account. Used for webhook authentication."
        keyType="webhook"
        listEndpoint="/api/api-keys"
        showCreator={false}
        title="Your keys"
      />
    </>
  );
}
