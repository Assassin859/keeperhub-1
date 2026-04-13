import { describe, expect, it } from "vitest";
import { getProtocol, registerProtocol } from "@/lib/protocol-registry";
import wethDef from "@/protocols/weth";

const KEBAB_CASE_REGEX = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const HEX_ADDRESS_REGEX = /^0x[0-9a-fA-F]{40}$/;

describe("WETH Protocol Definition (ABI-driven)", () => {
  it("imports without throwing", () => {
    expect(wethDef).toBeDefined();
    expect(wethDef.name).toBe("WETH");
    expect(wethDef.slug).toBe("weth");
  });

  it("protocol slug is valid kebab-case", () => {
    expect(wethDef.slug).toMatch(KEBAB_CASE_REGEX);
  });

  it("all action slugs are valid kebab-case", () => {
    for (const action of wethDef.actions) {
      expect(action.slug).toMatch(KEBAB_CASE_REGEX);
    }
  });

  it("every action references an existing contract", () => {
    const contractKeys = new Set(Object.keys(wethDef.contracts));
    for (const action of wethDef.actions) {
      expect(
        contractKeys.has(action.contract),
        `action "${action.slug}" references unknown contract "${action.contract}"`
      ).toBe(true);
    }
  });

  it("has no duplicate action slugs", () => {
    const slugs = wethDef.actions.map((a) => a.slug);
    expect(slugs.length).toBe(new Set(slugs).size);
  });

  it("all read actions define outputs", () => {
    const readActions = wethDef.actions.filter((a) => a.type === "read");
    for (const action of readActions) {
      expect(
        action.outputs,
        `read action "${action.slug}" must have outputs`
      ).toBeDefined();
      expect(action.outputs?.length).toBeGreaterThan(0);
    }
  });

  it("all contract addresses are valid hex format", () => {
    for (const [key, contract] of Object.entries(wethDef.contracts)) {
      for (const [chain, address] of Object.entries(contract.addresses)) {
        expect(
          address,
          `contract "${key}" chain "${chain}" address must be valid hex`
        ).toMatch(HEX_ADDRESS_REGEX);
      }
    }
  });

  it("has 3 actions (wrap, unwrap, balance-of)", () => {
    expect(wethDef.actions).toHaveLength(3);
    const slugs = wethDef.actions.map((a) => a.slug);
    expect(slugs).toContain("wrap");
    expect(slugs).toContain("unwrap");
    expect(slugs).toContain("balance-of");
  });

  it("has 2 write actions and 1 read action", () => {
    const reads = wethDef.actions.filter((a) => a.type === "read");
    const writes = wethDef.actions.filter((a) => a.type === "write");
    expect(reads).toHaveLength(1);
    expect(writes).toHaveLength(2);
  });

  it("has 1 contract", () => {
    expect(Object.keys(wethDef.contracts)).toHaveLength(1);
  });

  it("wrap action is payable with no inputs", () => {
    const wrap = wethDef.actions.find((a) => a.slug === "wrap");
    expect(wrap).toBeDefined();
    expect(wrap?.payable).toBe(true);
    expect(wrap?.inputs).toHaveLength(0);
    expect(wrap?.function).toBe("deposit");
    expect(wrap?.label).toBe("Wrap ETH");
  });

  it("unwrap action has one uint256 input", () => {
    const unwrap = wethDef.actions.find((a) => a.slug === "unwrap");
    expect(unwrap).toBeDefined();
    expect(unwrap?.payable).toBeUndefined();
    expect(unwrap?.inputs).toHaveLength(1);
    expect(unwrap?.inputs[0].name).toBe("wad");
    expect(unwrap?.inputs[0].type).toBe("uint256");
    expect(unwrap?.inputs[0].label).toBe("Amount (wei)");
    expect(unwrap?.function).toBe("withdraw");
  });

  it("balance-of action has address input and uint256 output with decimals", () => {
    const balanceOf = wethDef.actions.find((a) => a.slug === "balance-of");
    expect(balanceOf).toBeDefined();
    expect(balanceOf?.type).toBe("read");
    expect(balanceOf?.inputs).toHaveLength(1);
    expect(balanceOf?.inputs[0].name).toBe("account");
    expect(balanceOf?.inputs[0].type).toBe("address");
    expect(balanceOf?.inputs[0].label).toBe("Wallet Address");
    expect(balanceOf?.outputs).toHaveLength(1);
    expect(balanceOf?.outputs?.[0].name).toBe("balance");
    expect(balanceOf?.outputs?.[0].label).toBe("WETH Balance (wei)");
    expect(balanceOf?.outputs?.[0].decimals).toBe(18);
    expect(balanceOf?.function).toBe("balanceOf");
  });

  it("WETH contract is available on 5 chains", () => {
    const chains = Object.keys(wethDef.contracts.weth.addresses);
    expect(chains).toHaveLength(5);
    expect(chains).toContain("1");
    expect(chains).toContain("8453");
    expect(chains).toContain("42161");
    expect(chains).toContain("10");
    expect(chains).toContain("11155111");
  });

  it("registers in the protocol registry and is retrievable", () => {
    registerProtocol(wethDef);
    const retrieved = getProtocol("weth");
    expect(retrieved).toBeDefined();
    expect(retrieved?.slug).toBe("weth");
    expect(retrieved?.name).toBe("WETH");
  });
});
