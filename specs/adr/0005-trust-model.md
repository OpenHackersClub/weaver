# ADR 0005 — Trust Model: Cooperative Organization, Trusted Sync Server

- **Status:** Accepted
- **Date:** 2026-05-17
- **Supersedes:** Implicit threat-model assumptions in [`access-control.md`](../access-control.md) §0 and §8.2 as previously written. Recontextualizes ADR 0001, ADR 0004, and the framing of access control across the corpus.

## Context

weaver is built for a specific deployment shape that until now was implicit and bled into design decisions in places it shouldn't:

- **Operator profile**: an organization (company, firm, agency, research group) runs weaver on infrastructure it owns or controls — its own Cloudflare account, its own IdP integration, its own audit-log storage.
- **User profile**: authenticated users are **organization members** — employees, contractors, named external collaborators — interacting through approved clients. They are *cooperative*, not adversarial. Misbehavior is a personnel/HR issue, not a software-security issue.
- **Sync server profile**: the Cloudflare Durable Object + Worker + D1 + R2 stack runs in the organization's own account. **The sync server is operationally trusted**. There is no scenario where the organization's editor distrusts its own backend.

This is the same trust model as a Notion workspace, a Linear instance, a Figma team, or a Google Docs domain. Different from:

- A **public federated network** where every peer is independently operated (e.g. Mastodon, IPFS — different model entirely).
- A **zero-trust SaaS** where the vendor doesn't trust its own users (e.g. signed-by-default code-execution platforms — different problem).
- An **end-to-end-encrypted product** where the operator is *also* untrusted (e.g. Signal, 1Password — explicitly out of scope per D16).

Earlier drafts of `access-control.md` slid toward a zero-trust-internal-user framing — defending against "authenticated user, malicious within their scope" (Adversary A3) and motivating per-op CRDT validation in the Durable Object as a *security boundary* against insider attack. That framing was wrong for the deployment model and produced over-engineered machinery (per-op decomposition, partial-reject client rollback, origin-forge-attempt logging) whose costs aren't justified by the threats they defend against.

This ADR sets the record straight.

## Decision

**weaver adopts a cooperative-organization / trusted-server trust model.** Concretely:

1. **The sync server is trusted** to apply, relay, and persist updates correctly. We do not design any primitive that defends against the operator's own server.
2. **Authenticated users are cooperative**. We do not design primitives that defend against an authenticated insider crafting hostile CRDT updates to corrupt the schema, escalate permissions via op forgery, or exfiltrate other tiers via custom clients. If an insider goes rogue, the response is HR + audit-log review, not a per-op validator.
3. **Access control's job is org-level data scoping** — controlling who in the organization can see and modify which data, at what permission level, with audit-grade attribution for compliance.
4. **The remaining adversarial surface is external and AI-driven**, not internal-and-human:
   - Unauthenticated access attempts (defended at the WS upgrade gate).
   - Share-link abuse (defended by capability-token scope + expiry + revocation).
   - Credential theft / session hijack (defended by short token lifetimes + revocation).
   - Misconfigured permissions (defended by ACL audit tooling, not runtime checks against insiders).
   - **Prompt-injected AI agents** acting on hostile doc content (see [ADR 0006](./0006-ai-agent-threat-model.md)).
   - Audit-log integrity against external tampering (defended by hash-chain + R2 immutable retention).

## What we still defend (load-bearing)

| Concern | Mechanism | Reason |
|---|---|---|
| Unauthenticated access | WS upgrade gate; Biscuit verification; revocation check | An anonymous attacker is by definition outside the trusted set. |
| Doc-level access | D1 ACL lookup at upgrade | Org-level scoping baseline. |
| Tier-level read scoping | Subdoc partitioning (separate LoroDocs per tier) | Marketing must not receive Legal-confidential updates over the wire. Sync-protocol-level isolation is the cleanest guarantee. |
| Tier-level write scoping | Lightweight "does this connection's scope permit writing to this subdoc?" check on inbound frames | Prevents misconfigured or stale clients from writing to tiers they don't hold. Best-effort against bugs, not security. |
| Server-authoritative origin tagging | DO rewrites origin metadata to authenticated subject before applying / relaying | Compliance: a regulator asks "who edited this," there is a one-line answer. |
| Audit log with hash chain | Append-only log on R2, hash-chained per (doc, subdoc), latest hash exported off-host | Defends *the log itself* against external tampering after the fact. Not against the original author. |
| Awareness / presence filtering | Per-tier ephemeral filtering in the DO | Prevents leaking who-is-where to viewers who shouldn't see them. |
| Token revocation propagation | KV write + DO broadcast | A leaving employee's access stops working within seconds. |
| Capability-token attenuation for delegation | Biscuit caveats (ADR 0004) | Lets users delegate scoped grants to AI agents and share-link recipients without server round-trips. |

## What we explicitly stop defending (de-loaded)

| Earlier concern | Why removed |
|---|---|
| **Insider crafts a malformed Loro update to violate the schema** | We trust the client; schema validation moves to client + plugin contract. The DO does not need to decompose every incoming update to enforce schema as a security boundary. |
| **Insider crafts ops targeting subdocs they shouldn't write to** | Replaced by a single tier-write gate per inbound frame ("does connection scope include write on `frame.subdoc`?"). No per-op walk needed. |
| **Insider forges `origin` in change metadata** | The DO still rewrites `origin` to the authenticated subject on relay — this remains as an attribution primitive, not a forgery defense. We don't log forge-attempts; if the client tries, it just doesn't work. |
| **Insider does a "rate flood" to DoS other peers in the same doc** | Replaced by simple per-doc op-rate cap at the DO. Not adversary-class rate limiting; just basic operational protection. |
| **Per-op client rollback for partial-reject scenarios** | Removed. The simpler tier-write gate either accepts an entire frame or rejects it (e.g. "you don't have write on `confidential`"). Client surfaces a clear "you can't write here" error. No need for op-ID-tracked partial undo. |

## External corroboration: Jazz's pivot to a trusted authority

Jazz ([jazz.tools](https://jazz.tools)) built a local-first stack on the *opposite* end of this axis: permissions enforced purely by client-side cryptography over a CRDT (CoJSON groups, accounts, signed permission records — zero-trust over an untrusted sync server). In their [post-mortem on the classic Jazz design](https://jazz.tools/blog/what-we-learned-from-classic-jazz), they report pivoting in v2 toward the same model this ADR adopts:

- **Crypto-baked rules don't evolve.** > "permission mistakes were hard to evolve once baked into the system."
  Once a permission shape is encoded in signed records that every peer verifies, changing it is a migration across every replica. Our equivalent failure mode would have been embedding access logic in CRDT op semantics; we route it through Biscuit caveats + D1 ACLs + a server enforcement point precisely so policy can change without a CRDT migration.
- **Users want the local-first outcome, not the crypto.** > "most adopters cared more about the experience this design enabled than about the cryptographic machinery itself."
  Same observation drove our D16 (no E2E) and the choice to keep policy in Biscuit/Datalog rather than a CoJSON-style group-signature scheme.
- **Pure zero-trust is incompatible with real permission needs.** > "some useful permission rules still wanted at least a semi-trusted authority somewhere."
  This is the empirical finding behind §"Decision" above. Real rules — "auditors can read everything for 30 days then it expires," "an agent can rewrite text but not change permissions," "a leaving employee's access stops within seconds" — need a coordination point.
- **Their v2 lands where this ADR starts.** > "we now lean into the Jazz server as a trusted authority responsible for enforcing usefully complex permission policies that can evolve over time."
  Direct corroboration. A team that *built* the zero-trust-CRDT-permission stack, shipped it, and watched real users hit its limits, concluded that a trusted authority is load-bearing. We adopt that as the starting point, not the destination.

The lesson is **not** "don't use cryptography" — capability tokens, hash-chained audit logs, and origin attribution remain cryptographic primitives in our design. It's "don't make policy evolution depend on cryptographic record migration." Policy lives in tables and tokens; crypto guards attribution and tamper-evidence.

The Jazz post explicitly does not address group membership, role inheritance, revocation propagation, or key rotation under their v2 model — those remain our own engineering problems (see `access-control.md` §3, §4, §11, §12). The corroboration is on the *trust-model axis*, not on the implementation.

## What this changes about earlier decisions

- **ADR 0001 (Loro adoption)**: One of the rationales was "Loro's diff API gives cleaner server-side op decomposition for access-control validation than Yrs." That advantage **still exists** but is **no longer load-bearing**. Loro remains the chosen CRDT for its other advantages (native rich-text marks, peer-scoped undo, version control, perf headroom). A note has been added to ADR 0001 §"What this changes about earlier decisions."
- **ADR 0004 (Biscuit capability tokens)**: One of the rationales was "offline-verifiable in the hot path so the DO can verify every op without round-trip." That hot path doesn't exist anymore. Biscuit's load-bearing property under the new trust model is **attenuation for agent and share-link delegation** — still valuable. We stay on Biscuit (confirmed). The revaluation triggers in ADR 0004 remain valid; the priority of "the hot-path-verification reason for picking Biscuit" drops.
- **PRD positioning**: Previously listed "Server-enforced op-level access control" as one of four product pillars distinguishing weaver from Lexical / ProseMirror / Tiptap / BlockSuite. Drop that pillar. The three remaining differentiators (AI-agents-as-CRDT-peers, CRDT-as-document-model, local-first) are the real moat; **audit-grade attribution** stays as a property (not a "moat-pillar") since most editors can in principle do it but most don't.
- **`access-control.md`**: Section 0 (threat model) is rewritten to reflect this ADR. Section 6 (write scoping / op validation) is simplified from a multi-stage decomposition pipeline to a tier-write gate. Section 7 (client rollback) is reduced to "show the user an error." Section 8 (origin + audit) is unchanged.

## Multi-tenant / hosted-weaver variant (future)

If weaver ever ships a **hosted SaaS** where multiple unrelated organizations share infrastructure operated by us:

- Within an org's space: this ADR still holds (cooperative users, trusted server).
- Across orgs: standard SaaS isolation — different DOs / namespaces per org; we (the operator) become trusted to keep tenants apart.
- That doesn't change the editor's design; it changes our operational posture.

A multi-tenant deployment with hostile co-tenants is not in v1 scope. If it becomes necessary, treat it as a separate ADR (likely "ADR 00XX — multi-tenant isolation").

## Reversibility

If a customer demands a zero-trust-internal-user posture (regulated industry that distrusts its own users; intelligence/defense; etc.):

- The earlier elaborate machinery (per-op decomposition + schema validation in the DO + partial-reject client rollback) can be added back **as a configurable strict-mode**, not as the default. The DO architecture already has Loro WASM resident; the validation pipeline is software, not protocol.
- This would itself be a new ADR superseding the strict-mode parts of the present one.

We commit to revisiting this ADR if:

1. A signed contract requires zero-trust-internal-user enforcement.
2. We discover a class of bug that materially manifests as a security incident under cooperative-user assumptions (e.g. a stale client persistently corrupting docs).
3. We pivot to a federated / E2E-encrypted deployment model (which would supersede D16 as well).

## Consequences

### Immediate
- `access-control.md` §0, §6 (was §8.4 Primitive 4), §7 (client rollback), §17 (testing focus) rewritten to match.
- `prd.md` positioning §2 (four-pillar table) reduced to three differentiators; audit-attribution remains in §10 decisions index.
- ADR 0001 + ADR 0004 get a "what this changes" note pointing here.
- Landing-page manifesto `§01.04` rephrased: from "the server validates ops, not just connections" to "every edit carries cryptographic attribution to its author." (Same fact; less zero-trust framing.)
- [ADR 0006](./0006-ai-agent-threat-model.md) is the companion record: with insider-attack out of scope, prompt-injected agents are the sharpest remaining adversarial concern.

### Downstream
- Phase 0 / Phase 2 deliverables in the roadmap stay the same in *what* ships, but their security framing softens. Op-validation work in Phase 2 becomes "tier-write gate + schema sanity check," not "adversarial op-validation pipeline."
- The audit log + hash chain stay as full deliverables. They serve compliance/attribution; they're cheap; they're worth keeping.
- The testing strategy (out in a future spec, per the audit-finding) reorients: property tests for tier-routing correctness and audit-chain integrity are primary; "fuzz with adversarial updates to provoke validator escape" drops to nice-to-have.

## References

- [`access-control.md`](../access-control.md) — primary spec being recontextualized.
- [ADR 0001 — Loro adoption](./0001-adopt-loro-over-yjs.md) — one rationale (cleaner server-side op decomposition) was load-bearing under the old trust model; now incidental.
- [ADR 0004 — Capability tokens](./0004-capability-token-format.md) — one rationale (offline-verify hot path) was load-bearing under the old trust model; now incidental. Attenuation rationale is unchanged.
- [ADR 0006 — AI agent threat model](./0006-ai-agent-threat-model.md) — the companion piece on what *remains* adversarial.
- [STRIDE threat-modeling framework](https://learn.microsoft.com/en-us/azure/security/develop/threat-modeling-tool-threats) — would be applied with insider classes (S = Spoofing of authenticated peer; E = Elevation of privilege by authenticated insider) reduced to informational, not enforced.
