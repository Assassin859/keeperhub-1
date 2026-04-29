/**
 * E2E baseline for the current fork-based event-tracker architecture.
 *
 * Requires the `test` docker-compose profile (test-anvil, test-localstack,
 * test-redis). Run with:
 *
 *   docker compose --profile test up -d test-anvil test-localstack test-localstack-init test-redis
 *   pnpm test
 *
 * Skipped when SKIP_INFRA_TESTS=true.
 */

import type { SQSClient } from "@aws-sdk/client-sqs";
import type { ethers } from "ethers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  getAnvilChainId,
  getAnvilRpcUrl,
  getAnvilWallet,
  getAnvilWssUrl,
  waitForAnvil,
} from "./helpers/anvil-helpers";
import {
  type DeployedFixture,
  deployEventEmitter,
} from "./helpers/fixture-contract";
import { type MockApiServer, startMockApi } from "./helpers/mock-api";
import {
  createQueue,
  deleteQueue,
  makeSqsClient,
  pollForMessage,
  purgeQueue,
} from "./helpers/sqs-helpers";

const SKIP_INFRA_TESTS = process.env.SKIP_INFRA_TESTS === "true";
const AWS_ENDPOINT = process.env.AWS_ENDPOINT_URL ?? "http://localhost:4567";
const REDIS_HOST = process.env.REDIS_HOST ?? "localhost";
const REDIS_PORT = Number(process.env.REDIS_PORT ?? 6380);
const TEST_QUEUE_NAME = "keeperhub-event-tracker-test-queue";
const WORKFLOW_ID = "test-workflow-keep-295";
const EMITTED_VALUE = 42n;

// Shape of the payload emitted by AbstractChain.executeWorkflow. Kept loose
// because event-serializer output is the production contract; tighten in
// later phases if we want to assert more aggressively.
interface TypedValue {
  value: string;
  type: string;
}
interface TriggerData {
  eventName: string;
  args: Record<string, TypedValue>;
  address: string;
  transactionHash: string;
}
interface SqsBody {
  workflowId: string;
  triggerType: string;
  triggerData: TriggerData;
}

function buildWorkflow(address: string, abi: unknown[]): unknown {
  return {
    id: WORKFLOW_ID,
    name: "Phase 0 Baseline",
    userId: "test-user",
    organizationId: "test-org",
    enabled: true,
    nodes: [
      {
        id: "node-1",
        type: "trigger",
        selected: false,
        data: {
          type: "event-trigger",
          label: "Emitted",
          status: "active",
          description: "Baseline listener for fork architecture",
          config: {
            network: String(getAnvilChainId()),
            eventName: "Emitted",
            contractABI: JSON.stringify(abi),
            triggerType: "event",
            contractAddress: address,
          },
        },
      },
    ],
  };
}

function buildNetworks(): Record<number, unknown> {
  const now = new Date().toISOString();
  return {
    [getAnvilChainId()]: {
      id: `local-${getAnvilChainId()}`,
      chainId: getAnvilChainId(),
      name: "Anvil",
      symbol: "ETH",
      chainType: "evm",
      defaultPrimaryRpc: getAnvilRpcUrl(),
      defaultFallbackRpc: getAnvilRpcUrl(),
      defaultPrimaryWss: getAnvilWssUrl(),
      defaultFallbackWss: getAnvilWssUrl(),
      isTestnet: true,
      isEnabled: true,
      createdAt: now,
      updatedAt: now,
    },
  };
}

describe.skipIf(SKIP_INFRA_TESTS)(
  "event-tracker: on-chain event -> SQS (fork architecture baseline)",
  () => {
    let fixture: DeployedFixture;
    let wallet: ethers.Wallet;
    let mockApi: MockApiServer;
    let sqsClient: SQSClient;
    let queueUrl: string;
    // Modules imported dynamically after env is set up, so redis.ts picks up
    // the correct REDIS_HOST/PORT before it constructs its client.
    let syncModule: {
      registerContainer: () => Promise<void>;
      removeAllContainers: () => Promise<void>;
      rtStorage?: { quit?: () => Promise<unknown> };
    };
    let synchronizeData: () => Promise<void>;

    beforeAll(async () => {
      await waitForAnvil();
      wallet = getAnvilWallet();
      fixture = await deployEventEmitter(wallet);

      sqsClient = makeSqsClient(AWS_ENDPOINT);
      queueUrl = await createQueue(sqsClient, TEST_QUEUE_NAME, AWS_ENDPOINT);
      await purgeQueue(sqsClient, queueUrl);

      mockApi = await startMockApi();
      mockApi.setResponse("/api/workflows/events", {
        workflows: [buildWorkflow(fixture.address, fixture.abi)],
        networks: buildNetworks(),
      });

      // Env vars below are mutated and intentionally not restored in afterAll.
      // This is safe because the event-tracker modules capture them at import
      // time (e.g. lib/config/environment.ts, lib/sync/redis.ts constructs
      // its Redis client eagerly). A restore after import would have no effect
      // on the captured values, so it is not worth the noise. If another test
      // file is added that imports event-tracker modules with different env,
      // run test files in separate vitest processes (isolate: true) or move
      // this setup to a global setup file.
      process.env.KEEPERHUB_API_URL = mockApi.url;
      process.env.KEEPERHUB_API_KEY = "test-key";
      process.env.SQS_QUEUE_URL = queueUrl;
      process.env.AWS_ENDPOINT_URL = AWS_ENDPOINT;
      process.env.AWS_REGION = "us-east-1";
      process.env.AWS_ACCESS_KEY_ID = "test";
      process.env.AWS_SECRET_ACCESS_KEY = "test";
      process.env.REDIS_HOST = REDIS_HOST;
      process.env.REDIS_PORT = String(REDIS_PORT);
      process.env.NODE_ENV = "test";

      const redisMod = await import("../../lib/sync/redis");
      syncModule = redisMod.syncModule;
      const mainMod = await import("../../src/main");
      synchronizeData = mainMod.synchronizeData;

      await syncModule.removeAllContainers();
      await syncModule.registerContainer();
    }, 120_000);

    afterAll(async () => {
      // Ask the fork architecture to tear down its child processes by sending
      // an empty workflow list, then disconnect Redis so vitest exits cleanly.
      try {
        mockApi?.setResponse("/api/workflows/events", {
          workflows: [],
          networks: {},
        });
        if (synchronizeData) {
          await synchronizeData();
        }
      } catch {
        // best-effort cleanup
      }
      try {
        await syncModule?.removeAllContainers?.();
      } catch {
        // ignore
      }
      try {
        // Reaches into SyncModule's `rtStorage` field, which is declared
        // `protected` on SyncManager. This is brittle but acceptable:
        // event-tracker has no public disconnect API today, vitest hangs on
        // the open ioredis connection if we don't close it, and Phase 6 of
        // the KEEP-295 plan deletes SyncModule/Redis entirely. When this
        // bracket goes, so does the need for this access.
        await syncModule?.rtStorage?.quit?.();
      } catch {
        // ignore
      }
      await mockApi?.close();
      await deleteQueue(sqsClient, queueUrl);
    }, 30_000);

    it("forwards an emitted contract event to SQS", async () => {
      await synchronizeData();

      // The child process forks, connects its WSS provider, validates the
      // contract, and attaches its filter asynchronously. Anvil WSS
      // subscriptions only deliver events from blocks AFTER the subscribe
      // call, so an event emitted before the child is ready is lost forever.
      //
      // There is no production hook to await "child is listening" from the
      // test process (IPC is consumed inside WorkflowHandler). Instead: emit
      // in a retry loop, polling SQS after each emit. Each emit is a new
      // transaction with a new tx_hash, so Redis dedup never interferes.
      // Once the listener is up, the next emit lands in SQS. First-attempt
      // success is the typical case; retries only kick in if the child is
      // slow to boot on a busy machine.
      const MAX_ATTEMPTS = 10;
      const PER_ATTEMPT_MS = 3_000;
      const emitEvent = fixture.contract.getFunction("emitEvent");

      let received: Awaited<ReturnType<typeof pollForMessage>> = null;
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const tx = await emitEvent(EMITTED_VALUE);
        await tx.wait();
        received = await pollForMessage(sqsClient, queueUrl, PER_ATTEMPT_MS);
        if (received) {
          break;
        }
      }

      expect(
        received,
        `no SQS message received after ${MAX_ATTEMPTS} emits; listener likely never attached`,
      ).not.toBeNull();

      const body = JSON.parse(received?.Body ?? "{}") as SqsBody;
      expect(body.workflowId).toBe(WORKFLOW_ID);
      expect(body.triggerType).toBe("event");
      expect(body.triggerData.eventName).toBe("Emitted");
      expect(body.triggerData.address.toLowerCase()).toBe(
        fixture.address.toLowerCase(),
      );
      expect(body.triggerData.args.value.type).toBe("uint256");
      expect(body.triggerData.args.value.value).toBe(String(EMITTED_VALUE));
      expect(body.triggerData.args.sender.type).toBe("address");
      expect(body.triggerData.args.sender.value.toLowerCase()).toBe(
        wallet.address.toLowerCase(),
      );
    }, 90_000);
  },
);
