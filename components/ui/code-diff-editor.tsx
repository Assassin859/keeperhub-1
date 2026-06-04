"use client";

import "@/lib/monaco-loader-config";

import {
  DiffEditor,
  type DiffEditorProps,
  type DiffOnMount,
} from "@monaco-editor/react";
import { useTheme } from "next-themes";
import { useCallback } from "react";
import { vercelDarkTheme } from "@/lib/monaco-theme";

/**
 * Read-only side-by-side JSON diff, themed to match the single-file
 * CodeEditor wrapper. Used by the workflow version-history overlay to show a
 * previous vs. selected snapshot.
 */
export function CodeDiffEditor(props: DiffEditorProps): React.ReactElement {
  const { resolvedTheme } = useTheme();
  const propsOnMount = props.onMount;

  const handleMount: DiffOnMount = useCallback(
    (editor, monaco) => {
      monaco.editor.defineTheme("vercel-dark", vercelDarkTheme);
      monaco.editor.setTheme(
        resolvedTheme === "dark" ? "vercel-dark" : "light"
      );
      propsOnMount?.(editor, monaco);
    },
    [propsOnMount, resolvedTheme]
  );

  return (
    <DiffEditor
      language="json"
      {...props}
      onMount={handleMount}
      options={{
        readOnly: true,
        renderSideBySide: true,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        ...props.options,
      }}
      theme={resolvedTheme === "dark" ? "vercel-dark" : "light"}
    />
  );
}
