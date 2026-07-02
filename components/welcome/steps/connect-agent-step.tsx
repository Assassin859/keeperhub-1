"use client";

import { KeyRound } from "lucide-react";
import { motion, useAnimationControls } from "motion/react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ApiKeysOverlay } from "@/components/overlays/api-keys-overlay";
import { useOverlay } from "@/components/overlays/overlay-provider";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CopyBlock } from "@/components/welcome/copy-block";
import { ConnectAgentPreview } from "@/components/welcome/previews";
import { WelcomeShell } from "@/components/welcome/welcome-shell";
import { getAgentFrameworks } from "@/lib/agent-connect-commands";
import { markOnboardingComplete } from "@/lib/welcome-status";

const BACK_PATH = "/welcome/invite-members";

/**
 * Wizard step 3: connect an AI agent to KeeperHub. Shows the MCP endpoint and
 * per-framework setup commands, and lets the user mint an org API key via the
 * existing (dual-factor) API keys overlay -- deletable / rotatable later.
 */
export function ConnectAgentStep(): React.ReactElement {
  const router = useRouter();
  const { open } = useOverlay();
  const apiKeyBoxControls = useAnimationControls();
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [finishing, setFinishing] = useState(false);
  const [mcpUrl, setMcpUrl] = useState(
    process.env.NEXT_PUBLIC_APP_URL
      ? `${process.env.NEXT_PUBLIC_APP_URL}/mcp`
      : ""
  );

  useEffect(() => {
    if (!mcpUrl) {
      setMcpUrl(`${window.location.origin}/mcp`);
    }
  }, [mcpUrl]);

  const frameworks = getAgentFrameworks(mcpUrl || "/mcp", apiKey);

  const openApiKeys = (): void => {
    open(ApiKeysOverlay, {
      onKeyCreated: (key, type) => {
        if (type === "organisation") {
          setApiKey(key);
        }
      },
    });
  };

  // Persist completion, then hard-navigate home so the session is refetched
  // server-side with the new flag; the root gate then keeps the user on the
  // canvas instead of bouncing back here.
  const finish = async (): Promise<void> => {
    if (!apiKey) {
      await apiKeyBoxControls.start({
        scale: [1, 1.08, 1],
        transition: { duration: 0.6, ease: "easeInOut" },
      });
      return;
    }
    setFinishing(true);
    await markOnboardingComplete();
    window.location.assign("/");
  };

  return (
    <WelcomeShell
      busy={finishing}
      contentClassName="max-w-none"
      description="Point your AI agent at KeeperHub over MCP, then drive workflows and wallets from your editor."
      nextLabel="Finish"
      onBack={() => router.push(BACK_PATH)}
      onNext={finish}
      preview={
        <ConnectAgentPreview
          apiKey={apiKey}
          mcpUrl={mcpUrl || "{origin}/mcp"}
        />
      }
      stepIndex={2}
      title="Connect your AI agent"
    >
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-2">
          <p className="font-medium text-sm">MCP endpoint</p>
          <CopyBlock body={mcpUrl || `${"{origin}"}/mcp`} />
        </div>

        <div className="flex flex-col gap-2">
          <p className="font-medium text-sm">Setup</p>
          <Tabs defaultValue={frameworks[0].id}>
            <TabsList className="h-auto flex-wrap justify-start gap-1">
              {frameworks.map((framework) => (
                <TabsTrigger
                  className="flex-none px-4 py-1.5"
                  key={framework.id}
                  value={framework.id}
                >
                  {framework.label}
                </TabsTrigger>
              ))}
            </TabsList>
            {frameworks.map((framework) => (
              <TabsContent
                className="flex flex-col gap-2 pt-2"
                key={framework.id}
                value={framework.id}
              >
                {framework.snippets.map((snippet) => (
                  <CopyBlock
                    body={snippet.body}
                    caption={snippet.caption}
                    key={snippet.caption}
                  />
                ))}
                {framework.note ? (
                  <p className="text-muted-foreground text-xs">
                    {framework.note}
                  </p>
                ) : null}
              </TabsContent>
            ))}
          </Tabs>
        </div>

        <motion.div
          animate={apiKeyBoxControls}
          className="flex flex-col gap-2 rounded-lg border border-border p-4"
        >
          <p className="font-medium text-sm">Organization API key</p>
          <p className="text-muted-foreground text-sm">
            {apiKey
              ? "Your new key is filled into the command above. Copy it now -- it won't be shown again. You can rotate it anytime in Settings."
              : "Generate a key for headless or CI setups. It's dropped straight into the command above. You can delete or rotate it anytime in Settings."}
          </p>
          <Button
            className="w-fit"
            onClick={openApiKeys}
            type="button"
            variant={apiKey ? "ghost" : "outline"}
          >
            <KeyRound className="size-4" />
            {apiKey ? "Manage API keys" : "Generate API key"}
          </Button>
        </motion.div>
      </div>
    </WelcomeShell>
  );
}
