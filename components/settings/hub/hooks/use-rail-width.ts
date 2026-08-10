"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// Mirrors COLLAPSED_WIDTH and EXPANDED_WIDTH in the workflow sidebar, so the
// two rails are the same size in both states. Kept as local constants rather
// than imported, to avoid pulling that component into this bundle.
export const RAIL_COLLAPSED_WIDTH = 60;
export const RAIL_EXPANDED_WIDTH = 200;

const SNAP_THRESHOLD = (RAIL_COLLAPSED_WIDTH + RAIL_EXPANDED_WIDTH) / 2;
const STORAGE_KEY = "keeperhub-settings-rail-expanded";

export type RailWidth = {
  width: number;
  expanded: boolean;
  /** True only while a drag is in progress, so the width can skip its transition. */
  dragging: boolean;
  toggle: () => void;
  onResizeStart: (event: React.MouseEvent) => void;
};

/**
 * Width of the settings rail, mirroring the workflow sidebar: drag the edge to
 * resize, snap to collapsed or expanded, and remember the choice. Starts
 * expanded and only narrows once the reader asks for it.
 */
export function useRailWidth(): RailWidth {
  const [expanded, setExpanded] = useState(true);
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const dragging = useRef(false);

  // Read after mount: the server has no way to know the stored choice, so
  // reading during render would risk a hydration mismatch.
  useEffect(() => {
    setExpanded(localStorage.getItem(STORAGE_KEY) !== "false");
  }, []);

  const persist = useCallback((next: boolean): void => {
    setExpanded(next);
    localStorage.setItem(STORAGE_KEY, String(next));
  }, []);

  const onResizeStart = useCallback(
    (event: React.MouseEvent): void => {
      event.preventDefault();
      dragging.current = true;
      setDragWidth(expanded ? RAIL_EXPANDED_WIDTH : RAIL_COLLAPSED_WIDTH);

      const clamp = (x: number): number =>
        Math.min(RAIL_EXPANDED_WIDTH, Math.max(RAIL_COLLAPSED_WIDTH, x));

      const onMove = (move: MouseEvent): void => {
        if (dragging.current) {
          setDragWidth(clamp(move.clientX));
        }
      };
      const onUp = (up: MouseEvent): void => {
        dragging.current = false;
        // Released past the halfway point it opens, below it snaps shut.
        persist(clamp(up.clientX) >= SNAP_THRESHOLD);
        setDragWidth(null);
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };

      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [expanded, persist]
  );

  const resting = expanded ? RAIL_EXPANDED_WIDTH : RAIL_COLLAPSED_WIDTH;
  const width = dragWidth ?? resting;

  return {
    dragging: dragWidth !== null,
    expanded: width >= SNAP_THRESHOLD,
    onResizeStart,
    toggle: () => persist(!expanded),
    width,
  };
}
