"use client";

import { AddressWithExplorer } from "@/components/safe/address-with-explorer";
import type { DirectRuleInput } from "@/components/safe/policy-wizard";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { DirectRuleRow } from "./direct-rule-row";
import { POLICY_PERIOD_OPTIONS } from "./policy-token-row";

const DEFAULT_PERIOD_SECONDS = POLICY_PERIOD_OPTIONS[1].seconds;

type DirectRulesSectionProps = {
  rules: DirectRuleInput[];
  chainId: number;
  safeAddress?: string;
  onChange: (next: DirectRuleInput[]) => void;
};

function makeBlankRule(): DirectRuleInput {
  return {
    kind: "erc20-transfer",
    tokenAddress: null,
    tokenSymbol: "",
    tokenDecimals: 18,
    counterparty: "",
    amountHuman: "",
    periodSeconds: DEFAULT_PERIOD_SECONDS,
  };
}

export function DirectRulesSection({
  rules,
  chainId,
  safeAddress,
  onChange,
}: DirectRulesSectionProps): React.ReactElement {
  const updateAt = (index: number, next: DirectRuleInput): void => {
    const copy = rules.slice();
    copy[index] = next;
    onChange(copy);
  };

  const removeAt = (index: number): void => {
    const copy = rules.slice();
    copy.splice(index, 1);
    onChange(copy);
  };

  const addRule = (): void => {
    onChange([...rules, makeBlankRule()]);
  };

  return (
    <div className="space-y-2">
      <Label className="text-xs">Direct transfers and approvals</Label>
      <div className="space-y-1 text-muted-foreground text-xs">
        <p>
          Each rule below authorises one specific transfer, approval, or native
          ETH send from this Safe through automated workflows. The Safe address
          being scoped:
        </p>
        {safeAddress && (
          <div>
            <AddressWithExplorer address={safeAddress} chainId={chainId} />
          </div>
        )}
        <p>
          For each rule you pick a token, a recipient or spender, and a
          per-period cap. Workflows on this Safe can call only those functions
          for that exact counterparty up to the cap. Anything else reverts on
          chain.
        </p>
      </div>
      <ul className="space-y-2">
        {rules.map((rule, idx) => (
          <li
            // biome-ignore lint/suspicious/noArrayIndexKey: rule rows are anonymous; index is stable for the row's lifetime in the list
            key={`direct-rule-${idx}`}
          >
            <DirectRuleRow
              chainId={chainId}
              onChange={(next) => updateAt(idx, next)}
              onRemove={() => removeAt(idx)}
              value={rule}
            />
          </li>
        ))}
      </ul>
      <Button onClick={addRule} size="sm" type="button" variant="outline">
        + Add rule
      </Button>
    </div>
  );
}
