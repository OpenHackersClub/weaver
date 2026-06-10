import { useEffect } from "react";
import type { Editor, PresenceHub } from "@weaver/core";
import { type PresenceCursor, attachPresenceOverlay } from "@weaver/dom";

/**
 * Bridges the shared `PresenceHub` to the `@weaver/dom` presence overlay: each
 * mock agent's presence record becomes a moving caret rendered over the
 * visitor's editor. Redraws on every presence change and every document
 * change (so carets follow block layout). Renders no DOM of its own.
 */
export const PresenceLayer = ({
  editor,
  presence,
  excludePeerId,
}: {
  editor: Editor;
  presence: PresenceHub;
  /** Session to omit — the local user's own caret is the real DOM caret. */
  excludePeerId?: string;
}) => {
  useEffect(() => {
    // EditorRoot (a sibling rendered before this component) has already
    // attached the bridge, so the contenteditable host exists.
    const host = document.querySelector(
      "[data-weaver-root]",
    ) as HTMLElement | null;
    if (!host) return;

    const overlay = attachPresenceOverlay(host);

    const draw = (): void => {
      const cursors: PresenceCursor[] = presence
        .all()
        .filter((r) => r.cursor !== null && r.peerId !== excludePeerId)
        .map((r) => ({
          peerId: r.peerId,
          label: r.label,
          color: r.color,
          blockId: r.cursor!.blockId,
          offset: r.cursor!.offset,
        }));
      overlay.render(cursors);
    };

    draw();
    const unsubPresence = presence.subscribe(draw);
    const unsubDoc = editor.doc.subscribe(() => draw());
    return () => {
      unsubPresence();
      unsubDoc();
      overlay.dispose();
    };
  }, [editor, presence, excludePeerId]);

  return null;
};
