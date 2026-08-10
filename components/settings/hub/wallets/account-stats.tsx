"use client";

import type { WalletAccountKind } from "@/components/overlays/wallet/account-row";
import { StatTile } from "../section";
import type { AssetRow } from "./use-account-assets";

export function AccountStats({
  account,
  rows,
  solanaIsTestnet,
}: {
  account: WalletAccountKind;
  rows: AssetRow[];
  solanaIsTestnet: boolean;
}): React.ReactElement {
  const isSafe = account.kind === "safe";
  const isSolana = account.kind === "turnkey" && account.family === "solana";

  // The Solana signer is not an EVM address, so the EVM balance feed that
  // powers the other tiles says nothing about it.
  if (isSolana) {
    return (
      <div className="grid gap-4 sm:grid-cols-3">
        <StatTile hint="Turnkey signer" label="Account type" value="EOA" />
        <StatTile
          hint={solanaIsTestnet ? "Devnet cluster" : "Mainnet cluster"}
          label="Network"
          value="Solana"
        />
        <StatTile
          hint="Shares the org's Turnkey wallet"
          label="Key material"
          value="Managed"
        />
      </div>
    );
  }

  return (
    <div className="grid gap-4 sm:grid-cols-3">
      <StatTile
        hint="Networks with a balance here"
        label="Funded networks"
        value={String(new Set(rows.map((r) => r.chainId)).size)}
      />
      <StatTile
        hint="Native and token balances"
        label="Assets held"
        value={String(rows.length)}
      />
      <StatTile
        hint={isSafe ? "Safe smart account" : "Turnkey signer"}
        label="Account type"
        value={isSafe ? "Safe" : "EOA"}
      />
    </div>
  );
}
