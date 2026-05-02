import type { IntegrationPlugin } from "@/plugins/registry";
import { registerIntegration } from "@/plugins/registry-core";
import { CoalitionIcon } from "./icon";

const coalitionPlugin: IntegrationPlugin = {
  type: "coalition",
  label: "Coalition",
  description:
    "Multi-party on-chain commitments with stake escrow and slashing. Propose, collect signatures, activate, slash on breach, dissolve cleanly.",
  icon: CoalitionIcon,
  singleConnection: true,
  requiresCredentials: false,
  formFields: [],
  testConfig: {
    getTestFunction: async () => {
      const { testCoalition } = await import("./test");
      return testCoalition;
    },
  },
  actions: [],
};

registerIntegration(coalitionPlugin);

export default coalitionPlugin;
