import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PresenceHub, PresenceRecord, Principal } from "@weaver/core";

/**
 * Presence wiring for an embedding app (`specs/presence.md` §API surface).
 *
 * This is the one point where app-owned *identity* (a `Principal`) crosses
 * into the weaver-owned presence *mechanism*: `usePresence` builds the local
 * `PresenceRecord` from the supplied principal, publishes it into the hub,
 * and keeps it alive with a heartbeat so remote timeout eviction never reaps
 * a live session. The transport is whatever the hub is wired to — in-tab
 * (Playground mock agents) or the WS relay (`initSync({ presence })`).
 */

/**
 * Default heartbeat. Must comfortably outpace the wire timeout (45 s on the
 * sync-core replica and networked hubs) — three missed beats before eviction.
 */
const DEFAULT_HEARTBEAT_MS = 15_000;

export interface UsePresenceOptions {
  /** The local user/agent, supplied by the embedding app — never fetched. */
  readonly self: Principal;
  /**
   * Session key override. Defaults to `<principal.id>#<random>` so the same
   * principal in two tabs publishes two records (`specs/presence.md`).
   */
  readonly sessionId?: string;
  /** Re-publish interval keeping the record alive. Default 15 s. */
  readonly heartbeatMs?: number;
  /**
   * The local caret to carry on the record, so remote peers render this
   * session in their caret overlay — not just the facepile. Cursors and
   * presence draw from the SAME record set; a roster entry without a caret
   * is only ever a session that has no selection placed. Re-publishes on
   * every change.
   */
  readonly cursor?: PresenceRecord["cursor"];
}

export interface PresenceApi {
  /** Every live record in the hub, self included. */
  readonly peers: ReadonlyArray<PresenceRecord>;
  /** The session key this hook publishes under. */
  readonly selfPeerId: string;
}

const sessionSuffix = (): string => Math.random().toString(36).slice(2, 8);

/** Subscribe a React component to a hub's live record set. */
export const usePresenceRecords = (
  hub: PresenceHub,
): ReadonlyArray<PresenceRecord> => {
  const [records, setRecords] = useState<ReadonlyArray<PresenceRecord>>(() =>
    hub.all(),
  );
  useEffect(() => {
    setRecords(hub.all());
    return hub.subscribe(() => setRecords(hub.all()));
  }, [hub]);
  return records;
};

export const usePresence = (
  hub: PresenceHub,
  options: UsePresenceOptions,
): PresenceApi => {
  const { self } = options;
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const selfPeerId = useMemo(
    () => options.sessionId ?? `${self.id}#${sessionSuffix()}`,
    [options.sessionId, self.id],
  );
  const peers = usePresenceRecords(hub);

  // The caret rides a ref so a moving cursor re-publishes (cheap `hub.set`)
  // WITHOUT tearing down the heartbeat effect — a remove+set per keystroke
  // would broadcast spurious roster churn to every peer.
  const cursor = options.cursor ?? null;
  const cursorRef = useRef<PresenceRecord["cursor"]>(cursor);
  cursorRef.current = cursor;

  const publish = useCallback((): void => {
    hub.set({
      peerId: selfPeerId,
      principalId: self.id,
      label: self.label,
      color: self.color ?? "#64748b",
      kind: self.kind,
      ...(self.avatarUrl !== undefined ? { avatarUrl: self.avatarUrl } : {}),
      mode: "idle",
      cursor: cursorRef.current,
    });
  }, [hub, selfPeerId, self]);

  useEffect(() => {
    publish();
    const beat = setInterval(publish, heartbeatMs);
    // Best-effort instant removal when the tab closes while the socket is
    // still open; the timeout eviction is the backstop for hard crashes.
    const onBeforeUnload = (): void => hub.remove(selfPeerId);
    window.addEventListener("beforeunload", onBeforeUnload);

    return () => {
      clearInterval(beat);
      window.removeEventListener("beforeunload", onBeforeUnload);
      hub.remove(selfPeerId);
    };
  }, [hub, selfPeerId, publish, heartbeatMs]);

  // Live caret: a selection change re-publishes the record in place.
  useEffect(() => {
    publish();
  }, [publish, cursor]);

  return useMemo(() => ({ peers, selfPeerId }), [peers, selfPeerId]);
};

export interface PresenceFacepileProps {
  readonly hub: PresenceHub;
  readonly className?: string;
  /** Avatars rendered before collapsing into a `+N` chip. Default 5. */
  readonly maxFaces?: number;
}

const initialsOf = (label: string): string =>
  label
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join("");

/**
 * Google-Docs-style avatar stack of everyone in the document. One face per
 * *principal* (a principal in two tabs renders once — facepiles show people,
 * caret overlays show sessions). Avatar image when the record carries one,
 * initials on the principal's color otherwise. Styling hooks:
 * `weaver-facepile`, `weaver-facepile-face`, `weaver-facepile-overflow`.
 */
export const PresenceFacepile = ({
  hub,
  className,
  maxFaces = 5,
}: PresenceFacepileProps) => {
  const records = usePresenceRecords(hub);

  const people = useMemo(() => {
    const byPrincipal = new Map<string, PresenceRecord>();
    for (const record of records) {
      byPrincipal.set(record.principalId ?? record.peerId, record);
    }
    return [...byPrincipal.entries()].sort(([, a], [, b]) =>
      a.label.localeCompare(b.label),
    );
  }, [records]);

  const visible = people.slice(0, maxFaces);
  const overflow = people.length - visible.length;

  return (
    <div
      className={["weaver-facepile", className].filter(Boolean).join(" ")}
      role="group"
      aria-label="People in this document"
      data-presence-facepile
    >
      {visible.map(([principalId, record]) => (
        <span
          key={principalId}
          className="weaver-facepile-face"
          title={record.label}
          data-presence-principal={principalId}
          data-presence-kind={record.kind}
          style={{ background: record.color }}
        >
          {record.avatarUrl !== undefined ? (
            <img src={record.avatarUrl} alt={record.label} />
          ) : (
            initialsOf(record.label)
          )}
        </span>
      ))}
      {overflow > 0 ? (
        <span className="weaver-facepile-overflow" data-presence-overflow>
          +{overflow}
        </span>
      ) : null}
    </div>
  );
};
