"use client";

import "driver.js/dist/driver.css";
import type { Alignment, Driver, Side } from "driver.js";
import { useAtomValue, useSetAtom } from "jotai";
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { useOverlay } from "@/components/overlays/overlay-provider";
import { api } from "@/lib/api-client";
import { authClient, useSession } from "@/lib/auth-client";
import { isAnonymousUser } from "@/lib/is-anonymous";
import { runCreateWalletPath } from "@/lib/onboarding/paths/create-wallet";
import { toursDisabled } from "@/lib/onboarding/tours-disabled";
import { waitForAnchor } from "@/lib/onboarding/wait-for-anchor";
import {
  centerNodeAtom,
  currentWorkflowIdAtom,
  currentWorkflowNameAtom,
  editorTourRequestedAtom,
  isExecutingAtom,
  nodesAtom,
  propertiesPanelActiveTabAtom,
  selectedNodeAtom,
  updateNodeDataAtom,
} from "@/lib/workflow/store";

const SEEN_KEY = "keeperhub-editor-tour-seen";
const TOUR_WORKFLOW_NAME = "Workflow Editor Tour";
// Sonner toast id for the "preparing the tour" loader shown during the async
// startup (wallet provisioning, anchor waits, driver.js dynamic import).
const TOUR_TOAST = "kh-tour-loading";
// The action grid stores an action's registry id (computeActionId = plugin/slug)
// in config.actionType, NOT its human label - so we match on the id here while
// the popover copy still says "Get Native Token Balance".
const BALANCE_ACTION = "web3/check-balance";
// Ethereum Mainnet chainId (Check Balance resolves a numeric network string).
const BALANCE_NETWORK = "1";
// A funded public mainnet address, so the run is green even when the user has
// no wallet of their own.
const FALLBACK_ADDRESS = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const WALLET_ANCHOR = '[data-testid="wallet-toolbar-address"]';

type StepSnapshot = {
  selectedActionType: string | undefined;
  isExecuting: boolean;
};

type StepMode = "next" | "auto" | "finish";

type StepDef = {
  id: string;
  selector: string;
  mode: StepMode;
  isComplete?: (snap: StepSnapshot) => boolean;
  popover: { title: string; description: string; side: Side; align: Alignment };
};

const ORIENT_STEP: StepDef = {
  id: "orient",
  selector: ".react-flow__node-trigger",
  mode: "next",
  popover: {
    title: "Workflow Editor Tour",
    description:
      "Let's build a workflow that checks a wallet's balance, then run it. Every workflow is a Trigger (the when) wired to an Action (the what).",
    side: "right",
    align: "start",
  },
};

const WALLET_STEP: StepDef = {
  id: "wallet",
  selector: WALLET_ANCHOR,
  mode: "next",
  popover: {
    title: "Your wallet",
    description:
      "This is your wallet, and its address is saved in your address book. We'll check its balance in the next step.",
    side: "bottom",
    align: "end",
  },
};

const PICK_BALANCE_STEP: StepDef = {
  id: "pick-balance",
  selector: '[data-testid="action-grid"]',
  mode: "auto",
  isComplete: (snap) => snap.selectedActionType === BALANCE_ACTION,
  popover: {
    title: "Choose an action",
    description:
      "This is the actions list. Pick Get Native Token Balance - it reads an on-chain balance - to add it to your step.",
    side: "left",
    align: "start",
  },
};

const CONFIGURE_STEP: StepDef = {
  id: "configure",
  selector: '[data-testid="properties-panel"]',
  mode: "next",
  popover: {
    title: "Configure the step",
    description:
      "We filled in Ethereum Mainnet and the wallet address for you. This panel is where every step is configured - inputs, connections, and outputs.",
    side: "left",
    align: "start",
  },
};

const RUN_STEP: StepDef = {
  id: "run",
  selector: '[data-tour="workflow-run"]',
  mode: "auto",
  isComplete: (snap) => snap.isExecuting,
  popover: {
    title: "Run it",
    description: "Click Run to check the balance live on-chain.",
    side: "bottom",
    align: "end",
  },
};

const RESULTS_STEP: StepDef = {
  id: "results",
  selector: '[data-testid="properties-panel"]',
  mode: "finish",
  popover: {
    title: "You ran your first workflow",
    description:
      "Green means success - the Runs tab here shows the balance and each step's output. That's the core loop: build, run, iterate.",
    side: "left",
    align: "start",
  },
};

function buildSteps(hasWallet: boolean): StepDef[] {
  const steps = [ORIENT_STEP];
  if (hasWallet) {
    steps.push(WALLET_STEP);
  }
  steps.push(PICK_BALANCE_STEP, CONFIGURE_STEP, RUN_STEP, RESULTS_STEP);
  return steps;
}

function markSeen(): void {
  try {
    localStorage.setItem(SEEN_KEY, "true");
  } catch {
    // Storage unavailable; nothing to persist.
  }
}

function buttonsFor(mode: StepMode): Array<"next" | "close"> {
  // Action steps advance programmatically, so only offer a way out (Skip).
  return mode === "auto" ? ["close"] : ["next", "close"];
}

// Resolve the address to check: the user's first saved address book entry (their
// wallet) when present, otherwise a funded public address so the run still goes
// green. Returns the address plus whether the wallet toolbar is on screen.
async function resolveTourContext(
  signal: AbortSignal
): Promise<{ address: string; hasWallet: boolean }> {
  const hasWallet = Boolean(document.querySelector(WALLET_ANCHOR));
  let address = FALLBACK_ADDRESS;
  try {
    const response = await fetch("/api/address-book", {
      credentials: "same-origin",
      signal,
    });
    if (response.ok) {
      const entries: unknown = await response.json();
      const first = Array.isArray(entries) ? entries[0] : undefined;
      const entryAddress = (first as { address?: unknown } | undefined)
        ?.address;
      if (typeof entryAddress === "string" && entryAddress.length > 0) {
        address = entryAddress;
      }
    }
  } catch {
    // Address book unreachable; keep the fallback address.
  }
  return { address, hasWallet };
}

// Only org admins/owners can provision a wallet (matches the overlay's gate).
// "organization: update" is granted to admin + owner in the access control, so
// it stands in for isAdmin without mounting a global useActiveOrganization hook
// (which would 401 for anonymous visitors). Fetched lazily inside the launch.
async function canCreateWallet(): Promise<boolean> {
  try {
    const result = await authClient.organization.hasPermission({
      permissions: { organization: ["update"] },
    });
    const typed = result as {
      data?: { success?: boolean };
      success?: boolean;
    } | null;
    return Boolean(typed?.data?.success ?? typed?.success);
  } catch {
    return false;
  }
}

// Read the freshly created org wallet's address so the balance step checks the
// user's own wallet; fall back to the address we already resolved if the lookup
// fails or the wallet isn't readable yet.
async function resolveWalletAddress(
  signal: AbortSignal,
  fallback: string
): Promise<string> {
  try {
    const response = await fetch("/api/user/wallet", {
      credentials: "same-origin",
      signal,
    });
    if (response.ok) {
      const data = (await response.json()) as { walletAddress?: unknown };
      if (
        typeof data.walletAddress === "string" &&
        data.walletAddress.length > 0
      ) {
        return data.walletAddress;
      }
    }
  } catch {
    // Keep the fallback address.
  }
  return fallback;
}

/**
 * Opt-in interactive walkthrough of the workflow editor. Launched by the
 * "Take a tour" button (which sets editorTourRequestedAtom and creates a fresh
 * default workflow). Drives driver.js step-by-step, advancing each action step
 * when the user actually performs it - observed read-only via the workflow
 * store, plus a few scripted writes (name the workflow, pre-fill the balance
 * network/address, open the Runs tab) so the first run is guaranteed green.
 * Signed-in only; anonymous users can't execute, so they get the sign-in card.
 */
export function EditorWalkthrough(): null {
  const { data: session } = useSession();
  const requested = useAtomValue(editorTourRequestedAtom);
  const setRequested = useSetAtom(editorTourRequestedAtom);
  const nodes = useAtomValue(nodesAtom);
  const selectedNodeId = useAtomValue(selectedNodeAtom);
  const isExecuting = useAtomValue(isExecutingAtom);
  const currentWorkflowId = useAtomValue(currentWorkflowIdAtom);
  const setNodeData = useSetAtom(updateNodeDataAtom);
  const setWorkflowName = useSetAtom(currentWorkflowNameAtom);
  const setActiveTab = useSetAtom(propertiesPanelActiveTabAtom);
  const setCenterNode = useSetAtom(centerNodeAtom);
  const { closeAll } = useOverlay();

  const driverRef = useRef<Driver | null>(null);
  // Latest overlay-close fn, read inside launch without re-triggering the
  // one-shot launch effect (its deps stay narrow on purpose).
  const closeAllRef = useRef(closeAll);
  closeAllRef.current = closeAll;
  // Aborts the in-flight launch on unmount only - never on a re-render, so the
  // setRequested(false) / nodes updates during startup can't cancel the tour.
  const abortRef = useRef<AbortController | null>(null);
  // "idle" -> "starting" (async driver load) -> "running"
  const stateRef = useRef<"idle" | "starting" | "running">("idle");
  // Latest nodes for the pre-fill write without making the advance effect
  // depend on the (new-every-render) nodes array.
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  // The step list and resolved address are fixed once the tour starts.
  const stepsRef = useRef<StepDef[]>([]);
  const addressRef = useRef(FALLBACK_ADDRESS);

  const selectedNode = nodes.find((node) => node.id === selectedNodeId);
  const rawActionType = selectedNode?.data.config?.actionType;
  const selectedActionType =
    typeof rawActionType === "string" ? rawActionType : undefined;

  // Start the tour once a fresh default workflow is loaded and the user is
  // eligible. Consumes the request so it fires exactly once.
  useEffect(() => {
    if (stateRef.current !== "idle" || !requested) {
      return;
    }
    if (toursDisabled() || isAnonymousUser(session?.user)) {
      setRequested(false);
      return;
    }
    const hasTrigger = nodes.some((node) => node.data.type === "trigger");
    const hasAction = nodes.some((node) => node.data.type === "action");
    if (!(currentWorkflowId && hasTrigger && hasAction)) {
      return;
    }

    setRequested(false);
    stateRef.current = "starting";

    const controller = new AbortController();
    abortRef.current = controller;

    const launch = async (): Promise<void> => {
      toast.loading("Preparing your tour", { id: TOUR_TOAST });
      try {
        const context = await resolveTourContext(controller.signal);
        if (controller.signal.aborted) {
          stateRef.current = "idle";
          return;
        }
        addressRef.current = context.address;
        let hasWallet = context.hasWallet;

        // No wallet yet: an admin can create one via the standalone Create Wallet
        // sub-path before we continue. Non-admins keep the public fallback address
        // (they can't provision a wallet), so the tour never dead-ends.
        if (!hasWallet && (await canCreateWallet())) {
          const result = await runCreateWalletPath({
            signal: controller.signal,
            closeOverlays: () => closeAllRef.current(),
          });
          if (controller.signal.aborted) {
            stateRef.current = "idle";
            return;
          }
          if (result === "done") {
            hasWallet = true;
            addressRef.current = await resolveWalletAddress(
              controller.signal,
              addressRef.current
            );
          }
        }

        const steps = buildSteps(hasWallet);
        stepsRef.current = steps;

        // Name the tour workflow (display + persist; best-effort).
        setWorkflowName(TOUR_WORKFLOW_NAME);
        api.workflow
          .update(currentWorkflowId, { name: TOUR_WORKFLOW_NAME })
          .catch(() => {
            // Non-fatal: the tour still works with the default name.
          });

        // Center the trigger node so the opening spotlight is well-framed.
        const triggerNode = nodesRef.current.find(
          (node) => node.data.type === "trigger"
        );
        if (triggerNode) {
          setCenterNode(triggerNode.id);
        }

        const anchor = await waitForAnchor(
          steps[0].selector,
          controller.signal
        );
        if (controller.signal.aborted || !anchor) {
          stateRef.current = "idle";
          return;
        }

        // Let the center animation settle so the spotlight aligns to the node.
        await new Promise((resolve) => setTimeout(resolve, 600));
        if (controller.signal.aborted) {
          stateRef.current = "idle";
          return;
        }

        const { driver } = await import("driver.js");
        if (controller.signal.aborted) {
          stateRef.current = "idle";
          return;
        }

        const instance = driver({
          allowClose: true,
          showProgress: false,
          doneBtnText: "Finish",
          nextBtnText: "Next",
          onDestroyed: () => {
            driverRef.current = null;
            stateRef.current = "idle";
            markSeen();
          },
          steps: steps.map((step) => ({
            element: step.selector,
            popover: {
              title: step.popover.title,
              description: step.popover.description,
              side: step.popover.side,
              align: step.popover.align,
              showButtons: buttonsFor(step.mode),
            },
          })),
        });

        driverRef.current = instance;
        stateRef.current = "running";
        instance.drive();
      } finally {
        toast.dismiss(TOUR_TOAST);
      }
    };

    launch().catch(() => {
      stateRef.current = "idle";
    });
    // No cleanup here on purpose: the launch must survive the re-render that
    // setRequested(false) triggers (and frequent nodes updates). It is torn
    // down only on unmount, below.
  }, [
    requested,
    session,
    nodes,
    currentWorkflowId,
    setRequested,
    setWorkflowName,
    setCenterNode,
  ]);

  // Advance action steps when the user completes them. The successor of every
  // auto step is a non-auto step, so this can't double-advance.
  useEffect(() => {
    const instance = driverRef.current;
    if (stateRef.current !== "running" || !instance) {
      return;
    }
    const steps = stepsRef.current;
    const index = instance.getActiveIndex();
    if (index === undefined) {
      return;
    }
    const step = steps[index];
    if (step?.mode !== "auto" || !step.isComplete) {
      return;
    }
    if (!step.isComplete({ selectedActionType, isExecuting })) {
      return;
    }

    const nextId = steps[index + 1]?.id;

    // Entering configure: pre-fill the balance network + address so it runs
    // green, then bring the node into focus - center it on the canvas and open
    // the properties tab so the panel shows the config the card points at.
    if (nextId === "configure") {
      const action = nodesRef.current.find(
        (node) =>
          node.data.type === "action" &&
          node.data.config?.actionType === BALANCE_ACTION
      );
      if (action) {
        const config = (action.data.config ?? {}) as Record<string, unknown>;
        if (!config.network) {
          setNodeData({
            id: action.id,
            data: {
              config: {
                ...config,
                network: BALANCE_NETWORK,
                address: addressRef.current,
              },
            },
          });
        }
        setActiveTab("properties");
        setCenterNode(action.id);
      }
    }

    // Entering results: surface the run output in the Runs tab.
    if (nextId === "results") {
      setActiveTab("runs");
    }

    instance.moveNext();
  }, [
    selectedActionType,
    isExecuting,
    setNodeData,
    setActiveTab,
    setCenterNode,
  ]);

  // Tear down a running tour if the controller unmounts.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      driverRef.current?.destroy();
    };
  }, []);

  return null;
}
