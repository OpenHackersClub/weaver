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
  /**
   * Declarative read-only toggle (lexical-parity §5). Omit to leave the
   * editor's own `setEditable` state untouched. When set, the prop owns the
   * flag: an imperative `editor.setEditable()` call made while mounted
   * persists only until the next render passes this prop again — mixing the
   * two means the prop wins.
   */
  readonly editable?: boolean;
}

export const EditorRoot = ({
  editor,
  className,
  style,
  autoFocus,
  bridgeOptions,
  hostRef,
  editable,
}: EditorRootProps) => {
  const ref = useRef<HTMLDivElement | null>(null);
  const optsRef = useRef<BridgeOptions | undefined>(bridgeOptions);
  optsRef.current = bridgeOptions;

  useEffect(() => {
    if (editable !== undefined) editor.setEditable(editable);
  }, [editor, editable]);

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
