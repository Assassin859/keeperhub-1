"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type SpendCapResponse = {
  dailyCapWei: string | null;
  dailyUsedWei: string;
};

const WEI_PER_ETH = BigInt(10) ** BigInt(18);
const ETH_AMOUNT = /^\d+(\.\d{1,18})?$/;
const TRAILING_ZEROS = /0+$/;

function formatWeiToEth(wei: string): string {
  let value: bigint;
  try {
    value = BigInt(wei);
  } catch {
    return "0";
  }
  const whole = value / WEI_PER_ETH;
  const frac = (value % WEI_PER_ETH)
    .toString()
    .padStart(18, "0")
    .replace(TRAILING_ZEROS, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

function parseEthToWei(input: string): string | null {
  const trimmed = input.trim();
  if (!ETH_AMOUNT.test(trimmed)) {
    return null;
  }
  const [whole, frac = ""] = trimmed.split(".");
  const fracPadded = (frac + "0".repeat(18)).slice(0, 18);
  return (BigInt(whole) * WEI_PER_ETH + BigInt(fracPadded)).toString();
}

/**
 * Organization daily value-cap control. Reads and writes the active org's
 * `daily_value_cap_wei` via /api/analytics/spend-cap; the PUT is gated server
 * side by `organization:update` (owner/admin) over the session, so this only
 * mounts inside an admin-gated surface.
 */
export function SpendCapSection(): React.ReactElement {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [capWei, setCapWei] = useState<string | null>(null);
  const [usedWei, setUsedWei] = useState("0");
  const [input, setInput] = useState("");

  const load = useCallback(() => {
    setLoading(true);
    fetch("/api/analytics/spend-cap")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: SpendCapResponse | null) => {
        if (!data) {
          return;
        }
        setCapWei(data.dailyCapWei);
        setUsedWei(data.dailyUsedWei);
        setInput(data.dailyCapWei ? formatWeiToEth(data.dailyCapWei) : "");
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const save = useCallback(async (dailyValueCapWei: string | null) => {
    setSaving(true);
    try {
      const res = await fetch("/api/analytics/spend-cap", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dailyValueCapWei }),
      });
      if (res.ok) {
        setCapWei(dailyValueCapWei);
        setInput(dailyValueCapWei ? formatWeiToEth(dailyValueCapWei) : "");
        toast.success(
          dailyValueCapWei ? "Daily value cap saved" : "Daily value cap cleared"
        );
      } else if (res.status === 403) {
        toast.error("Only organization owners and admins can change the cap");
      } else {
        toast.error("Could not save the cap");
      }
    } catch {
      toast.error("Could not save the cap");
    } finally {
      setSaving(false);
    }
  }, []);

  const handleSave = useCallback(() => {
    const wei = parseEthToWei(input);
    if (wei === null) {
      toast.error("Enter a valid ETH amount (up to 18 decimals)");
      return;
    }
    save(wei);
  }, [input, save]);

  const usedEth = formatWeiToEth(usedWei);

  return (
    <div className="space-y-3">
      <h4 className="font-medium text-muted-foreground text-sm">
        Daily value cap
      </h4>
      <p className="text-muted-foreground text-xs">
        Limits the total native value (ETH) that direct execution API calls can
        move per day for this organization. Leave empty for no cap.
      </p>

      <div className="space-y-2">
        <Label className="text-sm" htmlFor="daily-value-cap">
          Cap (ETH per day)
        </Label>
        <Input
          disabled={loading || saving}
          id="daily-value-cap"
          inputMode="decimal"
          onChange={(e) => setInput(e.target.value)}
          placeholder="e.g. 1.5"
          value={input}
        />
        <p className="text-muted-foreground text-xs">
          {capWei
            ? `Current cap: ${formatWeiToEth(capWei)} ETH/day - used ${usedEth} ETH today`
            : `No cap set - used ${usedEth} ETH today`}
        </p>
      </div>

      <div className="flex gap-2">
        <Button
          className="flex-1"
          disabled={loading || saving}
          onClick={handleSave}
          size="sm"
          variant="outline"
        >
          {saving ? "Saving..." : "Save cap"}
        </Button>
        <Button
          disabled={loading || saving || !capWei}
          onClick={() => save(null)}
          size="sm"
          variant="ghost"
        >
          Clear
        </Button>
      </div>
    </div>
  );
}
