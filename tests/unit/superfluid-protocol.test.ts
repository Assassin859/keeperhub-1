import { describe, expect, it } from "vitest";
import superfluidProtocol, {
  CFA_FORWARDER_ADDRESS,
  GDA_FORWARDER_ADDRESS,
  SUPERFLUID_CHAIN_IDS,
} from "@/protocols/superfluid";

const ADDRESS_REGEX = /^0x[0-9a-fA-F]{40}$/;
const KEBAB_CASE_REGEX = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const EXPECTED_CHAINS: string[] = [...SUPERFLUID_CHAIN_IDS];

const CFA_FORWARDER = CFA_FORWARDER_ADDRESS;

type SuperfluidAction = (typeof superfluidProtocol.actions)[number];

const findAction = (slug: string): SuperfluidAction | undefined =>
  superfluidProtocol.actions.find((a) => a.slug === slug);

describe("Superfluid protocol", () => {
  describe("metadata", () => {
    it("declares the expected name, slug, and description", () => {
      expect(superfluidProtocol.name).toBe("Superfluid");
      expect(superfluidProtocol.slug).toBe("superfluid");
      expect(superfluidProtocol.description).toBeTruthy();
      expect(superfluidProtocol.website).toBe("https://superfluid.org");
    });
  });

  describe("cfaForwarder contract", () => {
    it("declares cfaForwarder with the same address on all six chains", () => {
      const contract = superfluidProtocol.contracts.cfaForwarder;
      expect(contract).toBeDefined();
      expect(Object.keys(contract.addresses).sort()).toEqual(
        [...EXPECTED_CHAINS].sort()
      );
      const unique = new Set(Object.values(contract.addresses));
      expect(unique.size).toBe(1);
      expect([...unique][0]).toBe(CFA_FORWARDER);
      for (const addr of Object.values(contract.addresses)) {
        expect(addr).toMatch(ADDRESS_REGEX);
      }
    });

    it("ships an inline ABI containing the 5 expected functions", () => {
      const contract = superfluidProtocol.contracts.cfaForwarder;
      expect(contract.abi).toBeTruthy();
      const abi = JSON.parse(contract.abi as string) as Array<{
        type: string;
        name?: string;
      }>;
      const fnNames = abi
        .filter((f) => f.type === "function")
        .map((f) => f.name)
        .sort();
      expect(fnNames).toEqual(
        [
          "createFlow",
          "deleteFlow",
          "getAccountFlowrate",
          "getFlowInfo",
          "updateFlow",
        ].sort()
      );
    });
  });

  describe("create-flow action", () => {
    it("is declared as a write action against cfaForwarder.createFlow", () => {
      const action = findAction("create-flow");
      expect(action).toBeDefined();
      expect(action?.type).toBe("write");
      expect(action?.contract).toBe("cfaForwarder");
      expect(action?.function).toBe("createFlow");
      expect(action?.slug).toMatch(KEBAB_CASE_REGEX);
    });

    it("has the five expected inputs in order", () => {
      const action = findAction("create-flow");
      const names = action?.inputs.map((i) => i.name);
      expect(names).toEqual([
        "token",
        "sender",
        "receiver",
        "flowRate",
        "userData",
      ]);
    });

    it("marks userData as advanced with default 0x", () => {
      const action = findAction("create-flow");
      const userData = action?.inputs.find((i) => i.name === "userData");
      expect(userData?.advanced).toBe(true);
      expect(userData?.default).toBe("0x");
    });

    it("includes the int96 helpTip on flowRate", () => {
      const action = findAction("create-flow");
      const flowRate = action?.inputs.find((i) => i.name === "flowRate");
      expect(flowRate?.helpTip).toContain("Wei per second");
      expect(flowRate?.helpTip).toContain("int96");
    });
  });

  describe("update-flow action", () => {
    it("is declared as a write action against cfaForwarder.updateFlow", () => {
      const action = findAction("update-flow");
      expect(action).toBeDefined();
      expect(action?.type).toBe("write");
      expect(action?.contract).toBe("cfaForwarder");
      expect(action?.function).toBe("updateFlow");
    });

    it("has the same input shape as create-flow", () => {
      const action = findAction("update-flow");
      const names = action?.inputs.map((i) => i.name);
      expect(names).toEqual([
        "token",
        "sender",
        "receiver",
        "flowRate",
        "userData",
      ]);
    });
  });

  describe("delete-flow action", () => {
    it("is declared as a write action against cfaForwarder.deleteFlow", () => {
      const action = findAction("delete-flow");
      expect(action).toBeDefined();
      expect(action?.type).toBe("write");
      expect(action?.contract).toBe("cfaForwarder");
      expect(action?.function).toBe("deleteFlow");
    });

    it("has token/sender/receiver/userData inputs", () => {
      const action = findAction("delete-flow");
      const names = action?.inputs.map((i) => i.name);
      expect(names).toEqual(["token", "sender", "receiver", "userData"]);
    });
  });

  describe("get-flow action", () => {
    it("is declared as a read action against cfaForwarder.getFlowInfo", () => {
      const action = findAction("get-flow");
      expect(action).toBeDefined();
      expect(action?.type).toBe("read");
      expect(action?.contract).toBe("cfaForwarder");
      expect(action?.function).toBe("getFlowInfo");
    });

    it("declares the four expected outputs with decimals on rate/deposit", () => {
      const action = findAction("get-flow");
      const outputs = action?.outputs ?? [];
      expect(outputs.map((o) => o.name)).toEqual([
        "lastUpdated",
        "flowRate",
        "deposit",
        "owedDeposit",
      ]);
      expect(outputs.find((o) => o.name === "flowRate")?.decimals).toBe(18);
      expect(outputs.find((o) => o.name === "deposit")?.decimals).toBe(18);
    });
  });

  describe("get-net-flow action", () => {
    it("is declared as a read action against cfaForwarder.getAccountFlowrate", () => {
      const action = findAction("get-net-flow");
      expect(action).toBeDefined();
      expect(action?.type).toBe("read");
      expect(action?.contract).toBe("cfaForwarder");
      expect(action?.function).toBe("getAccountFlowrate");
    });

    it("returns flowRate as int96 with decimals: 18", () => {
      const action = findAction("get-net-flow");
      const out = action?.outputs?.[0];
      expect(out?.name).toBe("flowRate");
      expect(out?.type).toBe("int96");
      expect(out?.decimals).toBe(18);
    });
  });

  describe("gdaForwarder contract", () => {
    const GDA_FORWARDER = GDA_FORWARDER_ADDRESS;

    it("declares gdaForwarder with the same address on all six chains", () => {
      const contract = superfluidProtocol.contracts.gdaForwarder;
      expect(contract).toBeDefined();
      expect(Object.keys(contract.addresses).sort()).toEqual(
        [...EXPECTED_CHAINS].sort()
      );
      const unique = new Set(Object.values(contract.addresses));
      expect(unique.size).toBe(1);
      expect([...unique][0]).toBe(GDA_FORWARDER);
    });

    it("ships an inline ABI with the 5 expected functions", () => {
      const contract = superfluidProtocol.contracts.gdaForwarder;
      const abi = JSON.parse(contract.abi as string) as Array<{
        type: string;
        name?: string;
      }>;
      const fnNames = abi
        .filter((f) => f.type === "function")
        .map((f) => f.name)
        .sort();
      expect(fnNames).toEqual(
        [
          "connectPool",
          "createPool",
          "distribute",
          "distributeFlow",
          "updateMemberUnits",
        ].sort()
      );
    });

    it("createPool ABI declares the (bool,bool) PoolConfig tuple", () => {
      const contract = superfluidProtocol.contracts.gdaForwarder;
      const abi = JSON.parse(contract.abi as string) as Array<{
        type: string;
        name?: string;
        inputs?: Array<{
          name: string;
          type: string;
          components?: Array<{ name: string; type: string }>;
        }>;
      }>;
      const createPool = abi.find(
        (f) => f.type === "function" && f.name === "createPool"
      );
      const config = createPool?.inputs?.find((i) => i.name === "config");
      expect(config?.type).toBe("tuple");
      expect(config?.components?.map((c) => c.name)).toEqual([
        "transferabilityForUnitsOwner",
        "distributionFromAnyAddress",
      ]);
    });
  });

  describe("GDA actions", () => {
    it("declares the five expected GDA action slugs", () => {
      const slugs = superfluidProtocol.actions
        .filter((a) => a.contract === "gdaForwarder")
        .map((a) => a.slug)
        .sort();
      expect(slugs).toEqual(
        [
          "connect-pool",
          "create-pool",
          "distribute",
          "distribute-flow",
          "update-member-units",
        ].sort()
      );
    });

    it("create-pool declares the config tuple input via components", () => {
      const action = findAction("create-pool");
      const config = action?.inputs.find((i) => i.name === "config");
      expect(config?.type).toBe("tuple");
      expect(config?.components?.map((c) => c.name)).toEqual([
        "transferabilityForUnitsOwner",
        "distributionFromAnyAddress",
      ]);
    });

    it("distribute-flow uses int96 flowRate with the shared helpTip", () => {
      const action = findAction("distribute-flow");
      const flowRate = action?.inputs.find((i) => i.name === "flowRate");
      expect(flowRate?.type).toBe("int96");
      expect(flowRate?.helpTip).toContain("Wei per second");
    });

    it("connect-pool documents that members must call from their own wallet", () => {
      const action = findAction("connect-pool");
      expect(action?.description.toLowerCase()).toContain("own wallet");
    });
  });

  describe("superToken contract", () => {
    it("declares superToken with userSpecifiedAddress: true", () => {
      const contract = superfluidProtocol.contracts.superToken;
      expect(contract).toBeDefined();
      expect(contract.userSpecifiedAddress).toBe(true);
    });

    it("ships an inline ABI with the 5 expected functions", () => {
      const contract = superfluidProtocol.contracts.superToken;
      const abi = JSON.parse(contract.abi as string) as Array<{
        type: string;
        name?: string;
      }>;
      const fnNames = abi
        .filter((f) => f.type === "function")
        .map((f) => f.name)
        .sort();
      expect(fnNames).toEqual(
        [
          "balanceOf",
          "downgrade",
          "getUnderlyingToken",
          "updateFlowOperatorPermissions",
          "upgrade",
        ].sort()
      );
    });
  });

  describe("SuperToken actions", () => {
    it("declares the five expected SuperToken action slugs", () => {
      const slugs = superfluidProtocol.actions
        .filter((a) => a.contract === "superToken")
        .map((a) => a.slug)
        .sort();
      expect(slugs).toEqual(
        [
          "get-super-token-balance",
          "get-underlying-token",
          "grant-flow-operator",
          "unwrap",
          "wrap",
        ].sort()
      );
    });

    it("wrap is a write action against superToken.upgrade", () => {
      const action = findAction("wrap");
      expect(action?.type).toBe("write");
      expect(action?.contract).toBe("superToken");
      expect(action?.function).toBe("upgrade");
    });

    it("unwrap is a write action against superToken.downgrade", () => {
      const action = findAction("unwrap");
      expect(action?.type).toBe("write");
      expect(action?.function).toBe("downgrade");
    });

    it("grant-flow-operator includes the bitmap helpTip on permissions", () => {
      const action = findAction("grant-flow-operator");
      const perms = action?.inputs.find((i) => i.name === "permissions");
      expect(perms?.type).toBe("uint8");
      expect(perms?.helpTip).toContain("1");
      expect(perms?.helpTip).toContain("2");
      expect(perms?.helpTip).toContain("4");
      expect(perms?.helpTip).toContain("7");
    });

    it("get-super-token-balance returns balance with decimals: 18", () => {
      const action = findAction("get-super-token-balance");
      expect(action?.type).toBe("read");
      expect(action?.outputs?.[0]?.decimals).toBe(18);
    });

    it("get-underlying-token returns an address output and takes no inputs", () => {
      const action = findAction("get-underlying-token");
      expect(action?.type).toBe("read");
      expect(action?.inputs).toEqual([]);
      expect(action?.outputs?.[0]?.type).toBe("address");
    });
  });

  describe("overall integrity", () => {
    it("declares 15 actions in total", () => {
      expect(superfluidProtocol.actions).toHaveLength(15);
    });

    it("every action slug is unique kebab-case", () => {
      const slugs = superfluidProtocol.actions.map((a) => a.slug);
      expect(new Set(slugs).size).toBe(slugs.length);
      for (const slug of slugs) {
        expect(slug).toMatch(KEBAB_CASE_REGEX);
      }
    });

    it("every action references a defined contract", () => {
      const contractKeys = new Set(Object.keys(superfluidProtocol.contracts));
      for (const action of superfluidProtocol.actions) {
        expect(contractKeys.has(action.contract)).toBe(true);
      }
    });

    it("every action's function exists in its contract's ABI", () => {
      for (const action of superfluidProtocol.actions) {
        const contract =
          superfluidProtocol.contracts[
            action.contract as keyof typeof superfluidProtocol.contracts
          ];
        const abi = contract.abi
          ? (JSON.parse(contract.abi) as Array<{
              type: string;
              name?: string;
            }>)
          : [];
        const fnNames = abi
          .filter((f) => f.type === "function")
          .map((f) => f.name);
        expect(fnNames).toContain(action.function);
      }
    });
  });
});
