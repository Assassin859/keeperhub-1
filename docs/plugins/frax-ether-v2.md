---
title: "Frax Ether V2"
description: "Liquid staking on Ethereum mainnet. Deposit native ETH to mint frxETH (1:1 receipt) or sfrxETH (yield-bearing ERC4626 vault) in one transaction."
---

# Frax Ether V2

Frax Ether V2 is the second-generation liquid staking system from Frax Finance. Users deposit native ETH and receive either frxETH (a 1:1 ETH receipt token) or sfrxETH (an ERC4626 vault share that accrues staking yield over time). The yield comes from validators operated by the Frax protocol; staking rewards accrue to sfrxETH holders.

Supported chains: Ethereum Mainnet only. The V2 minter contract lives at `0x7Bc6bad540453360F744666D625fec0ee1320cA3`. The frxETH and sfrxETH token addresses are unchanged from V1; only the minter and redemption queue are V2-specific. Read-only actions work without credentials. Write actions require a connected wallet and native ETH value.

## Actions

| Action | Type | Credentials | Description |
|--------|------|-------------|-------------|
| Mint frxETH | Write | Wallet | Deposit native ETH and mint frxETH 1:1 to the sending address |
| Mint frxETH to Recipient | Write | Wallet | Deposit native ETH and mint frxETH 1:1 to a different recipient |
| Mint and Stake into sfrxETH | Write | Wallet | Mint frxETH and immediately stake it in sfrxETH in one transaction |
| Check Mint Pause Status | Read | No | Read whether minting is currently paused on the V2 minter |

---

## Mint frxETH

Deposit native ETH and mint frxETH 1:1 to the sending address.

**Inputs:** None (the native ETH value sent with the transaction IS the input)

**Outputs:** none (minted frxETH is delivered to msg.sender)

**When to use:** workflows that need to convert native ETH into a liquid staking receipt token without immediately staking it. The frxETH can later be staked into sfrxETH, swapped on a DEX, used as collateral, or transferred.

---

## Mint frxETH to Recipient

Deposit native ETH from the sender and mint frxETH 1:1 to a separate recipient address. Useful for treasury operations where the funding account differs from the holding account.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| recipient | address | Address that will receive the minted frxETH |

**Outputs:** none (minted frxETH is delivered to the recipient address)

**When to use:** funding a multisig or sub-account with frxETH from an operational wallet, distributing frxETH to a beneficiary, or routing minted frxETH directly to a yield strategy contract.

---

## Mint and Stake into sfrxETH

Mint frxETH and immediately deposit it into the sfrxETH ERC4626 vault in a single transaction. Returns the amount of sfrxETH shares received.

**Inputs:**

| Input | Type | Description |
|-------|------|-------------|
| recipient | address | Address that will receive the minted sfrxETH shares |

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| shares | uint256 | sfrxETH Shares Received (wei), 18 decimals |

**When to use:** the most gas-efficient way to go from native ETH to yield-bearing sfrxETH. Skips the intermediate frxETH transfer and the separate vault deposit transaction.

---

## Check Mint Pause Status

Read whether minting is currently paused on the Frax Ether V2 minter.

**Inputs:** None

**Outputs:**

| Output | Type | Description |
|--------|------|-------------|
| paused | bool | True if minting is paused, false if mints are accepted |

**When to use:** as a gate in scheduled workflows so a mint action only runs when the contract is unpaused. Useful for resilient automation that should self-suspend during contract maintenance windows.
