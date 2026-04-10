import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";

const facilitatorClient = new HTTPFacilitatorClient({
  url:
    process.env.X402_FACILITATOR_URL ??
    "https://api.cdp.coinbase.com/platform/v2/x402",
});

export const server = new x402ResourceServer(facilitatorClient);
server.register("eip155:8453", new ExactEvmScheme()); // Base mainnet
