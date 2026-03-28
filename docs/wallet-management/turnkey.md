---
title: "Turnkey Wallet Integration"
description: "How KeeperHub integrates with Turnkey for secure enclave wallet management with key export."
---

# Turnkey Integration

Turnkey is one of the wallet providers available in KeeperHub. It uses secure enclaves to protect private keys and supports key export for advanced users.

## Creating a Turnkey Wallet

In the Organization Wallet dialog, select **Turnkey** as your provider and enter the email address for wallet creation. The wallet will be shared across your organization.

## How It Works

Turnkey generates and stores private keys inside secure hardware enclaves (TEEs). Signing requests are authenticated and executed within the enclave.

- **Secure enclave storage** -- keys never leave the hardware boundary during normal operation
- **Private key export** -- export your key if you need to migrate to another solution
- **Integrated operations** -- seamless signing for workflow transactions

## Wallet Funding

Topping up your Turnkey wallet with ETH is only required for workflow operations that execute on-chain transactions.

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

**Deposit**: Transfer ETH to your Turnkey wallet address to fund workflow operations.

**Withdraw**: Use the Withdraw function in the UI to transfer wallet balance out of KeeperHub.

**Export Key**: Use the key export feature to retrieve your private key if you need to migrate to another wallet solution.

## Network Support

- Ethereum Mainnet
- Sepolia Testnet

## When to Choose Turnkey

- You want the option to export private keys
- You prefer hardware enclave security model
- Your organization requires key portability
