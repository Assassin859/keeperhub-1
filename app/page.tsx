"use client";

import { useAtomValue, useSetAtom } from "jotai";
import { nanoid } from "nanoid";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api-client";
import { authClient, useSession } from "@/lib/auth-client";
import { isAnonymousUser } from "@/lib/is-anonymous";
import { refetchSidebar } from "@/lib/refetch-sidebar";
import {
  currentWorkflowIdAtom,
  currentWorkflowNameAtom,
  edgesAtom,
  editorTourRequestedAtom,
  hasSidebarBeenShownAtom,
  isTransitioningFromHomepageAtom,
  nodesAtom,
  type WorkflowNode,
} from "@/lib/workflow/store";

function createDefaultNodes() {
  const triggerId = nanoid();
  const actionId = nanoid();
  const edgeId = nanoid();

  const triggerNode: WorkflowNode = {
    id: triggerId,
    type: "trigger" as const,
    position: { x: 0, y: 0 },
    data: {
      label: "",
      description: "",
      type: "trigger" as const,
      config: { triggerType: "Manual" },
      status: "idle" as const,
    },
  };

  const actionNode: WorkflowNode = {
    id: actionId,
    type: "action" as const,
    position: { x: 272, y: 0 },
    selected: true,
    data: {
      label: "",
      description: "",
      type: "action" as const,
      config: {},
      status: "idle" as const,
    },
  };

  const edge = {
    id: edgeId,
    source: triggerId,
    target: actionId,
    type: "animated",
  };

  return { nodes: [triggerNode, actionNode], edges: [edge] };
}

const Home = () => {
  const router = useRouter();
  const { data: session } = useSession();
  const setNodes = useSetAtom(nodesAtom);
  const setEdges = useSetAtom(edgesAtom);
  const setCurrentWorkflowId = useSetAtom(currentWorkflowIdAtom);
  const setCurrentWorkflowName = useSetAtom(currentWorkflowNameAtom);
  const setHasSidebarBeenShown = useSetAtom(hasSidebarBeenShownAtom);
  const setIsTransitioningFromHomepage = useSetAtom(
    isTransitioningFromHomepageAtom
  );
  const hasCreatedWorkflowRef = useRef(false);
  const currentWorkflowName = useAtomValue(currentWorkflowNameAtom);
  const tourRequested = useAtomValue(editorTourRequestedAtom);
  const setTourRequested = useSetAtom(editorTourRequestedAtom);

  // Reset sidebar animation state when on homepage
  useEffect(() => {
    setHasSidebarBeenShown(false);
  }, [setHasSidebarBeenShown]);

  // Update page title when workflow name changes
  useEffect(() => {
    document.title = `${currentWorkflowName} - KeeperHub`;
  }, [currentWorkflowName]);

  // Helper to create anonymous session if needed
  const ensureSession = useCallback(async () => {
    if (!session) {
      await authClient.signIn.anonymous();
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }, [session]);

  // Handler to add initial nodes and create the workflow.
  // If the user already has workflows, navigate to the most recent one instead
  // of creating a new one. Anonymous users are limited to a single workflow.
  const handleAddNode = useCallback(async () => {
    if (hasCreatedWorkflowRef.current) {
      return;
    }
    hasCreatedWorkflowRef.current = true;

    try {
      await ensureSession();

      if (isAnonymousUser(session?.user)) {
        const existing = await api.workflow.getAll();
        if (existing.length > 0) {
          const latest = existing.sort(
            (a, b) =>
              new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
          )[0];
          setIsTransitioningFromHomepage(true);
          router.replace(`/workflows/${latest.id}`);
          return;
        }
      }

      const { nodes: defaultNodes, edges: defaultEdges } = createDefaultNodes();
      setNodes(defaultNodes);
      setEdges(defaultEdges);

      const newWorkflow = await api.workflow.create({
        name: "Untitled Workflow",
        description: "",
        nodes: defaultNodes,
        edges: defaultEdges,
      });

      refetchSidebar();
      sessionStorage.setItem("animate-sidebar", "true");
      setIsTransitioningFromHomepage(true);
      router.replace(`/workflows/${newWorkflow.id}`);
    } catch (error) {
      console.error("Failed to create workflow:", error);
      toast.error("Failed to create workflow");
      hasCreatedWorkflowRef.current = false;
      setTourRequested(false);
    }
  }, [
    session,
    setNodes,
    setEdges,
    ensureSession,
    router,
    setIsTransitioningFromHomepage,
    setTourRequested,
  ]);

  // Launch the editor walkthrough when "Take a tour" was requested (from the
  // account menu or the Setup Guide): build the fresh default workflow the
  // walkthrough controller drives. handleAddNode then navigates into the editor.
  const handleAddNodeRef = useRef(handleAddNode);
  handleAddNodeRef.current = handleAddNode;

  useEffect(() => {
    if (tourRequested && session && !isAnonymousUser(session.user)) {
      void handleAddNodeRef.current();
    }
  }, [tourRequested, session]);

  // Initialize with a temporary "add" node on mount
  useEffect(() => {
    const addNodePlaceholder: WorkflowNode = {
      id: "add-node-placeholder",
      type: "add",
      position: { x: 0, y: 0 },
      data: {
        label: "",
        type: "add",
        onClick: () => void handleAddNodeRef.current(),
      },
      draggable: false,
      selectable: false,
    };
    setNodes([addNodePlaceholder]);
    setEdges([]);
    setCurrentWorkflowId(null);
    setCurrentWorkflowName("New Workflow");
    hasCreatedWorkflowRef.current = false;
  }, [
    setNodes,
    setEdges,
    setCurrentWorkflowId,
    setCurrentWorkflowName,
  ]);

  // Canvas and toolbar are rendered by PersistentCanvas in the layout
  return null;
};

export default Home;
