/**
 * A principal is any identity that can be addressed inside a document —
 * a human collaborator or an AI agent peer (D9: agents are CRDT peers, not
 * API calls). Mentions tag principals; access control scopes them
 * (`specs/access-control.md` expresses subjects as `user:…` / `agent:…`
 * strings — `Principal.id` carries that same identifier).
 */
export type PrincipalKind = "user" | "agent";

export interface Principal {
  /** Stable identity, e.g. `"user:ada"` or `"agent-1"`. */
  readonly id: string;
  readonly kind: PrincipalKind;
  /** Human-readable display name, e.g. `"Ada Lovelace"`. */
  readonly label: string;
  /** Optional CSS color hint for chips / cursors. */
  readonly color?: string;
  /** Optional avatar image URL. */
  readonly avatarUrl?: string;
}

/**
 * The wire shape of a `mention` mark value as stored in LoroDoc. `userId`
 * predates the Principal type and is kept for storage compatibility — it
 * holds the principal's `id` whatever its kind.
 */
export interface MentionMarkValue {
  readonly userId: string;
  readonly label: string;
  readonly kind?: PrincipalKind;
}
