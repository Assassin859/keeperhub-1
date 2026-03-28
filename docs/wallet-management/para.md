---
title: "Para Wallet Integration"
description: "How KeeperHub integrates with Para for MPC-based wallet management."
---

# Para Integration

Para is one of the wallet providers available in KeeperHub. It uses multi-party computation (MPC) for signing, so private keys are never exposed to any single party.

## Creating a Para Wallet

In the Organization Wallet dialog, select **Para** as your provider and enter the email address for wallet creation. The wallet will be shared across your organization.

## How It Works

Para uses MPC-based signing to execute transactions without exposing private keys. This provides:

- **No private key management** -- cryptographic operations happen securely across multiple parties
- **Simplified experience** -- no need for seed phrases or hardware wallets
- **Integrated operations** -- seamless signing for workflow transactions

## Wallet Funding

Topping up your Para wallet with ETH is only required for workflow operations that execute on-chain transactions.

**When funding is needed**:

- Write function calls (require gas fees)
- Token or ETH transfer operations
- Any workflow steps that execute blockchain transactions

**When funding is not needed**:

- Read-only monitoring workflows
- Multisig monitoring workflows
- Read function calls

Balance updates are reflected in the KeeperHub interface and displayed per network.

## Wallet Management

**Deposit**: Transfer ETH to your Para wallet address to fund workflow operations.

**Withdraw**: Use the Withdraw function in the UI to transfer wallet balance out of KeeperHub.

## Network Support

- Ethereum Mainnet
- Sepolia Testnet

## Limitations

- Private key export is not supported (use [Turnkey](/wallet-management/turnkey) if key export is required)
- Token transfers are not yet supported but are planned for future releases
