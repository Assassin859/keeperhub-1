/**
 * Unit tests for KEEP-458 programmatic workflow builders.
 *
 * Walks every (protocol, chain) with co-located testData, builds the setup +
 * all read/write workflows across all 5 trigger types, and asserts the built
 * shape matches what the executor expects. Replaces the prior on-disk
 * fixture validator with a runtime check — no JSON tree to keep in sync.
 *
 * Pure logic — no DB, no RPC. Runs on every PR via `pnpm test:unit`.
 */

import { describe, expect, it } from "vitest";
import "@/protocols";
import { getProtocol } from "@/lib/protocol-registry";
import {
  buildActionWorkflow,
  buildSetupWorkflow,
  listCoverageTargets,
  TRIGGER_TYPES,
} from "@/lib/test-data/build-workflow";

const HEX_ADDRESS_REGEX = /^0x[0-9a-fA-F]{40}$/;
// Builder takes the persistent test wallet address as a runtime parameter
// (KEEP-529 made it HSM-generated, so the address differs per environment).
// The unit test passes a fixed placeholder; structural assertions still hold.
const TEST_WALLET = "0x0000000000000000000000000000000000000001";
const targets = listCoverageTargets();

describe("KEEP-458 build-workflow", () => {
  it("at least one protocol carries testData", () => {
    expect(targets.length).toBeGreaterThan(0);
  });

  for (const { protocolSlug, chainId } of targets) {
    describe(`${protocolSlug} (chain ${chainId})`, () => {
      const protocol = getProtocol(protocolSlug);

      describe("setup workflow", () => {
        const setup = buildSetupWorkflow(protocolSlug, chainId, TEST_WALLET);

        it("has Manual trigger + at least one action node", () => {
          expect(setup.nodes.some((n) => n.type === "trigger")).toBe(true);
          expect(setup.nodes.some((n) => n.type === "action")).toBe(true);
        });

        it("metadata: _phase=setup, _protocol, _chainId, _trigger=Manual", () => {
          expect(setup._phase).toBe("setup");
          expect(setup._protocol).toBe(protocolSlug);
          expect(setup._chainId).toBe(chainId);
          expect(setup._trigger).toBe("Manual");
        });

        it("approve nodes reference web3/approve-token with required keys", () => {
          const approveNodes = setup.nodes.filter(
            (n) =>
              n.type === "action" &&
              n.data?.config?.actionType === "web3/approve-token"
          );
          for (const node of approveNodes) {
            const cfg = node.data.config;
            expect(cfg.network).toBe(chainId);
            expect(cfg.tokenConfig).toEqual(expect.any(String));
            expect(cfg.spenderAddress).toMatch(HEX_ADDRESS_REGEX);
            expect(cfg.amount).toEqual(expect.any(String));
          }
        });
      });

      describe("action workflows", () => {
        if (!protocol) {
          return;
        }

        for (const action of protocol.actions) {
          for (const trigger of TRIGGER_TYPES) {
            const variant = `${action.slug} [${trigger}]`;
            describe(variant, () => {
              const built = buildActionWorkflow(
                protocolSlug,
                action.slug,
                chainId,
                trigger,
                TEST_WALLET
              );

              it("has trigger + action node and correct metadata", () => {
                expect(built.nodes.some((n) => n.type === "trigger")).toBe(
                  true
                );
                expect(built.nodes.some((n) => n.type === "action")).toBe(true);
                expect(built._phase).toBe(action.type);
                expect(built._protocol).toBe(protocolSlug);
                expect(built._chainId).toBe(chainId);
                expect(built._trigger).toBe(trigger);
              });

              it("action node config has actionType + network + _protocolMeta", () => {
                const actionNode = built.nodes.find((n) => n.type === "action");
                expect(actionNode).toBeDefined();
                const cfg = actionNode?.data?.config ?? {};
                expect(cfg.actionType).toBe(`${protocolSlug}/${action.slug}`);
                expect(cfg.network).toBe(chainId);
                const meta = JSON.parse(cfg._protocolMeta) as {
                  protocolSlug: string;
                  contractKey: string;
                  functionName: string;
                  actionType: "read" | "write";
                };
                expect(meta.protocolSlug).toBe(protocolSlug);
                expect(meta.contractKey).toBe(action.contract);
                expect(meta.functionName).toBe(action.function);
                expect(meta.actionType).toBe(action.type);
              });

              it("required action inputs are present", () => {
                const actionNode = built.nodes.find((n) => n.type === "action");
                const cfg = actionNode?.data?.config ?? {};
                const required = action.inputs.filter(
                  (i) => i.required ?? i.default === undefined
                );
                for (const input of required) {
                  expect(cfg).toHaveProperty(input.name);
                }
              });

              it("network is a registered deployment of the action's contract", () => {
                const contractDef = protocol.contracts[action.contract];
                expect(contractDef).toBeDefined();
                if (contractDef && !contractDef.userSpecifiedAddress) {
                  expect(contractDef.addresses[chainId]).toBeTruthy();
                }
              });
            });
          }
        }
      });
    });
  }
});
