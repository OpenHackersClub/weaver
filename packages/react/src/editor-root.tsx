import { useEffect, useRef, type CSSProperties } from "react";
import type { Editor } from "@weaver/core";
import { attachEditor } from "@weaver/dom";

export interface EditorRootProps {
  readonly editor: Editor;
  readonly className?: string;
  readonly style?: CSSProperties;
  readonly autoFocus?: boolean;
}

export const EditorRoot = ({
  editor,
  className,
  style,
  autoFocus,
}: EditorRootProps) => {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const bridge = attachEditor(editor, el);
    if (autoFocus) {
      // Defer focus so React's commit phase is done.
      queueMicrotask(() => el.focus());
    }
    return () => {
      bridge.detach();
    };
  }, [editor, autoFocus]);

  return <div ref={ref} className={className} style={style} />;
};
