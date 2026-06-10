import {
  useEffect,
  useRef,
  type CSSProperties,
  type MutableRefObject,
} from "react";
import type { Editor } from "@weaver/core";
import { attachEditor, type BridgeOptions } from "@weaver/dom";

export interface EditorRootProps {
  readonly editor: Editor;
  readonly className?: string;
  readonly style?: CSSProperties;
  readonly autoFocus?: boolean;
  /**
   * Options forwarded to `attachEditor`. Callback options are read through a
   * latest-ref proxy, so a new object identity per render does NOT re-attach
   * the bridge — but whether a callback is wired at all is decided at attach
   * time (when `editor` changes).
   */
  readonly bridgeOptions?: BridgeOptions;
  /** Receives the contenteditable host element once attached. */
  readonly hostRef?: MutableRefObject<HTMLDivElement | null>;
}

export const EditorRoot = ({
  editor,
  className,
  style,
  autoFocus,
  bridgeOptions,
  hostRef,
}: EditorRootProps) => {
  const ref = useRef<HTMLDivElement | null>(null);
  const optsRef = useRef<BridgeOptions | undefined>(bridgeOptions);
  optsRef.current = bridgeOptions;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (hostRef) hostRef.current = el;
    const opts = optsRef.current;
    const bridge = attachEditor(editor, el, {
      classList: opts?.classList,
      onMentionTrigger: opts?.onMentionTrigger
        ? (trigger) => optsRef.current?.onMentionTrigger?.(trigger)
        : undefined,
    });
    if (autoFocus) {
      // Defer focus so React's commit phase is done.
      queueMicrotask(() => el.focus());
    }
    return () => {
      bridge.detach();
      if (hostRef) hostRef.current = null;
    };
  }, [editor, autoFocus, hostRef]);

  return <div ref={ref} className={className} style={style} />;
};
