"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export const RAIL_COLLAPSED_WIDTH = 56;
// Opens at the workflow sidebar's width so the two line up, and can be dragged
// wider for the longer section names without becoming a second content column.
export const RAIL_DEFAULT_WIDTH = 200;
export const RAIL_MAX_WIDTH = 300;

const SNAP_THRESHOLD = (RAIL_COLLAPSED_WIDTH + RAIL_DEFAULT_WIDTH) / 2;
const STORAGE_KEY = "keeperhub-settings-rail-expanded";
const WIDTH_KEY = "keeperhub-settings-rail-width";

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
  const [openWidth, setOpenWidth] = useState(RAIL_DEFAULT_WIDTH);
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const dragging = useRef(false);

  // Read after mount: the server has no way to know the stored choice, so
  // reading during render would risk a hydration mismatch.
  useEffect(() => {
    setExpanded(localStorage.getItem(STORAGE_KEY) !== "false");
    const stored = Number(localStorage.getItem(WIDTH_KEY));
    if (Number.isFinite(stored) && stored > 0) {
      setOpenWidth(
        Math.min(RAIL_MAX_WIDTH, Math.max(RAIL_DEFAULT_WIDTH, stored))
      );
    }
  }, []);

  const persist = useCallback((next: boolean, width?: number): void => {
    setExpanded(next);
    localStorage.setItem(STORAGE_KEY, String(next));
    if (width !== undefined) {
      setOpenWidth(width);
      localStorage.setItem(WIDTH_KEY, String(width));
    }
  }, []);

  const onResizeStart = useCallback(
    (event: React.MouseEvent): void => {
      event.preventDefault();
      dragging.current = true;
      setDragWidth(expanded ? openWidth : RAIL_COLLAPSED_WIDTH);

      const clamp = (x: number): number =>
        Math.min(RAIL_MAX_WIDTH, Math.max(RAIL_COLLAPSED_WIDTH, x));

      const onMove = (move: MouseEvent): void => {
        if (dragging.current) {
          setDragWidth(clamp(move.clientX));
        }
      };
      const onUp = (up: MouseEvent): void => {
        dragging.current = false;
        const released = clamp(up.clientX);
        // Anything dragged past the halfway point stays open at the width it
        // was released at; below that it snaps shut.
        if (released >= SNAP_THRESHOLD) {
          persist(true, Math.max(RAIL_DEFAULT_WIDTH, released));
        } else {
          persist(false);
        }
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
    [expanded, openWidth, persist]
  );

  const resting = expanded ? openWidth : RAIL_COLLAPSED_WIDTH;
  const width = dragWidth ?? resting;

  return {
    dragging: dragWidth !== null,
    expanded: width >= SNAP_THRESHOLD,
    onResizeStart,
    toggle: () => persist(!expanded),
    width,
  };
}
