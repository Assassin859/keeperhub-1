"use client";

import { Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { SettingsCard } from "../section";

/**
 * The MCP server URL agents point at. Resolved after mount when
 * NEXT_PUBLIC_APP_URL is unset, to avoid a hydration mismatch.
 */
export function McpEndpointCard(): React.ReactElement {
  const [url, setUrl] = useState(
    process.env.NEXT_PUBLIC_APP_URL
      ? `${process.env.NEXT_PUBLIC_APP_URL}/mcp`
      : ""
  );

  useEffect(() => {
    if (!url) {
      setUrl(`${window.location.origin}/mcp`);
    }
  }, [url]);

  return (
    <SettingsCard
      description="Point an MCP client here. It opens a browser to sign in, so there is no key to paste."
      title="MCP endpoint"
    >
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded bg-muted px-3 py-2 font-mono text-xs">
          {url || "/mcp"}
        </code>
        <Button
          onClick={() => {
            navigator.clipboard.writeText(url);
            toast.success("Copied to clipboard");
          }}
          size="sm"
          variant="outline"
        >
          <Copy className="size-3.5" />
          Copy
        </Button>
      </div>
    </SettingsCard>
  );
}
