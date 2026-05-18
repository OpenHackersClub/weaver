# ADR 0004 — Capability Token Format: Biscuit (with Documented Fallbacks)

- **Status:** Accepted
- **Date:** 2026-05-17
- **Relates to:** [`access-control.md` §2](../access-control.md); [`prd.md` §10 D15](../prd.md)

## Context

[`access-control.md`](../access-control.md) makes the capability token the load-bearing primitive of weaver's auth model:

- WS upgrade gate verifies it (§4)
- Subdoc partitioning derives from its caveats (§5)
- Op validation checks scope from its caveats (§6)
- Agent delegation works by user-side **attenuation** of the user's own token (§11)

The format wasn't independently justified — `access-control.md` §2 just picks Biscuit and lists properties. This ADR backs that choice with an explicit alternatives review, criteria, fallbacks, and revaluation triggers.

## Criteria

Every option is judged on the same five axes — the same ones used in [`access-control.md`](../access-control.md) §2:

1. **Attenuable** — holder can derive a stricter sub-token *offline*, without a round-trip to the issuer. Required for: agent delegation, share-link creation, ephemeral capabilities.
2. **Offline-verifiable** — verifier checks signature + caveats locally, no D1/KV roundtrip on connection setup and inbound-frame gating. (Earlier drafts framed this as needing to be hot enough for per-op validation; under [ADR 0005](./0005-trust-model.md) per-op validation is no longer load-bearing, so the hot-path bar drops to "fast at WS upgrade and per-frame tier check." Still sub-ms with Biscuit.)
3. **Expressive policy** — caveats encode weaver's actual constraints (`doc in [...]`, `action in [...]`, `subdoc_tag in [...]`, `time < ...`, `subject == ...`).
4. **WASM/Worker-friendly** — runs in sub-ms inside a Durable Object on `workerd`.
5. **Capability-first, not identity-first** — designed for "what this token authorizes," not "who is the user."

Secondary axes (don't disqualify; do break ties): ecosystem size, debuggability, audit history, standardization momentum, language support.

## Candidates evaluated

| Option | Attenuable | Offline-verify | Policy | WASM | Capability-first | Ecosystem | Notes |
|---|---|---|---|---|---|---|---|
| **Biscuit** | ✅ | ✅ | Datalog | ✅ (Rust→WASM) | ✅ | small but growing | Chosen |
| **Macaroons** | ✅ | ✅ | predicate strings | partial | ✅ | older, scattered | Strongest fallback |
| **UCAN** | ✅ | ✅ | JSON capability objects | ✅ (JS-first) | ✅ | IPFS/Filecoin/Fission | Right shape, wrong ecosystem fit for v1 |
| **JWT + scope strings** | ❌ | ✅ | flat strings | ✅ | ❌ (identity-first) | universal | Used at the *session* layer only |
| **PASETO + custom caveats** | ❌ (need to build chain) | ✅ | flexible | ✅ | ❌ | small but solid | If we build chain on top, we've reinvented Biscuit/Macaroons worse |
| **OAuth2 + opaque + introspection** | ❌ | ❌ (server lookup) | server-side | n/a | partial | universal | Kills the offline-verify property |
| **GNAP** (IETF emerging) | server-mediated | partial | spec-defined | n/a | ✅ | very new | Track; not adopt-able yet |
| **UMA 2.0** (OAuth2 extension) | server-mediated | depends | standard | n/a | ✅ | thin | Wrong direction (server-mediated, not client-attenuable) |
| **VC / DIDs (W3C)** | ✅ (chains) | ✅ | JSON-LD | partial | ✅ | growing | Over-engineered for centralized SaaS |
| **Cedar / OPA / Rego** | n/a — policy languages, not token formats | — | — | partial / ✅ | — | growing / universal | Complementary inside verifier, not a token |

## Decision

**Adopt Biscuit as weaver's capability token format.** Use a thin wrapper interface so we can swap implementations without changing call sites.

### Why Biscuit over each peer

**Biscuit vs Macaroons.** Both are attenuable capability tokens with the same conceptual model (root token + chained caveats, verified offline). Biscuit wins on:

- **Datalog caveat language** is genuinely more readable and reviewable than Macaroons' predicate strings (`check if doc($d), $d in [...]` vs ad-hoc `doc = "X" | doc = "Y"`).
- **Third-party caveats** (delegation chains across servers) are cleaner-specified.
- **Rust+WASM bindings** are first-class; Macaroons' Rust story is fragmented.
- **Sharper published verification semantics.** Macaroons' caveat-evaluation semantics vary subtly across implementations.

Macaroons is the **fallback** if Biscuit's maintenance falters: the data model translates 1:1, and Macaroons has a longer track record (Tarsnap, HashiCorp Vault, Google internally) which appeals if a customer demands a more "boring" credential format.

**Biscuit vs UCAN.** UCAN is the right *shape* (attenuable, offline-verifiable, capability-first) but its design assumptions don't match weaver's deployment:

- UCAN's natural principal model is **DIDs** — every actor has a keypair they manage. weaver is a centralized SaaS where users SSO through Google/Okta/etc. and never manage keys. Using UCAN here means minting `did:key:` identifiers inside our auth Worker — paying the abstraction tax without using the abstraction.
- UCAN shines for **decentralized trust** (Alice's UCAN verifies without her home server). We are explicitly the central trust root by design.
- UCAN's **cross-service composition** payoff (same token works across multiple providers) is moot — weaver doesn't federate across vendors in v1.

Where UCAN *would* win:

- JSON body is more debuggable than Biscuit's binary.
- JS ecosystem (`ucanto`, `@ucans/core`) is more mature than `biscuit-auth-wasm`.
- Less novel as a credential format for security review.

These don't outweigh the principal-model mismatch in v1, but UCAN is the natural answer **if our shape changes** (see Revaluation triggers).

**Biscuit vs JWT + scopes.** JWT is the boring default. It loses on the core requirement: **no attenuation**. Delegating to an agent means a round-trip to the auth Worker for every new agent token. This kills the "user can spawn ephemeral agents instantly" UX, which is the core differentiator (research §9, ADR 0001).

JWT is still in the stack — at the **session** layer between IdP and weaver auth Worker (see "Dual-token pattern" below).

**Biscuit vs PASETO + custom caveats.** PASETO is JWT done right (no `alg:none` footgun, cleaner profiles), but **not attenuable out of the box**. Building a caveat chain on top yields a worse Biscuit/Macaroon. If we needed to roll our own, we'd pick PASETO as the primitive — but we don't need to roll our own when Biscuit exists.

**Biscuit vs OAuth2 + introspection (opaque tokens).** Every op revalidation becomes a network round-trip — kills the sub-ms offline-verify property. Could be patched with aggressive caching, but at that point we're rebuilding offline verification badly.

**Biscuit vs GNAP.** Promising IETF spec, but **far too young** — RFC stages, minimal library ecosystem, nothing for Workers/DOs. Track; do not adopt.

**Biscuit vs Cedar / OPA / Rego.** These are *policy languages* layered inside the verifier, not token formats. Biscuit's Datalog already handles our policy needs. If weaver's policy grows much richer than `doc × subdoc × action × time` (e.g. arbitrary-attribute ABAC, role hierarchies with negation), revisit Cedar as a complement inside the verifier — Biscuit token, Cedar policy. Today it would be premature abstraction.

## Dual-token pattern (explicit)

Clarifies what `access-control.md` slightly conflates:

```
External IdP (Google/Okta/...)
   ↓ OAuth2/OIDC
Auth Worker
   ↓ short-lived JWT (session, identity, refresh)
Browser
   ↓ exchanges JWT for a Biscuit when opening a doc
   ↓ Biscuit (per-doc capability, attenuable for agents/share-links)
Durable Object
```

Each layer does what it's good at:

- **OAuth2/OIDC** for user authentication. We don't reinvent SSO.
- **JWT** for short-lived session/identity. Ubiquitous, debuggable.
- **Biscuit** for per-doc, per-agent, attenuable capability. The only exotic layer.

`access-control.md` will be updated to reflect this layering explicitly.

## Wrapper interface (the swap insurance)

Every call site goes through this Effect-TS service:

```ts
// @weaver/server/src/auth/capability.ts
export interface CapabilityToken {
  readonly _tag: "CapabilityToken";
}

export class CapabilityVerifier extends Context.Tag("CapabilityVerifier")<
  CapabilityVerifier,
  {
    readonly verify: (
      token: string,
      facts: Record<string, string | number | string[]>,
    ) => Effect.Effect<VerifiedCapability, TokenInvalid | TokenExpired | CaveatFailed>;
  }
>() {}

export class CapabilityIssuer extends Context.Tag("CapabilityIssuer")<
  CapabilityIssuer,
  {
    readonly issue: (claims: RootClaims) => Effect.Effect<string, never>;
    readonly attenuate: (
      parent: string,
      caveats: CaveatSet,
    ) => Effect.Effect<string, AttenuationInvalid>;
  }
>() {}
```

Two implementations live in `@weaver/server/src/auth/impl/`:

- `BiscuitImpl` — wraps `biscuit-auth-wasm`. The default.
- `MacaroonImpl` — wraps `macaroon-rs` via WASM. Fallback. Implemented in Phase 0 as a smoke test to validate the wrapper actually abstracts cleanly; not deployed.

Adding a third (UCAN, future) is a new file plus a config switch. No call site changes.

### Caveat-set translation

Biscuit's Datalog is more expressive than Macaroon's predicates. The wrapper's `CaveatSet` type is the **lowest-common-denominator** of the implementations we want to support:

```ts
type CaveatSet = {
  docs?: ReadonlyArray<string>;
  actions?: ReadonlyArray<string>;
  subdoc_tags?: ReadonlyArray<string>;
  subdoc_tags_deny?: ReadonlyArray<string>;
  expires_at: Date;
  subject?: string;
  agent_tools?: ReadonlyArray<string>;
};
```

If we later need Datalog-specific caveats (e.g. third-party caveats), we extend `CaveatSet` with an optional `biscuit_extensions` field that the Macaroon impl will refuse to issue/verify. Callers handle the absence gracefully (they don't depend on it for any v1 feature).

## What ADR 0005 changes about this ADR

The original framing emphasized "offline-verifiable in the hot path so the DO can verify every op without round-trip" as a load-bearing reason to pick Biscuit. Under [ADR 0005](./0005-trust-model.md) (cooperative-org trust model), per-op validation is not the security boundary; per-frame tier-write gating is. The verify-fast-on-hot-path argument shrinks correspondingly.

What remains load-bearing for Biscuit:

- **Attenuation for agent delegation** — the user attenuates their own token offline to issue a scoped grant to an agent. JWT can't do this. This is the primary feature [ADR 0005 §"Agent threat surface"](./0005-trust-model.md#agent-threat-surface) leans on.
- **Attenuation for share-links** — same property, different audience.
- **Datalog caveats** — still more reviewable than JWT scope strings or Macaroon predicate strings.

If we were re-deciding from scratch under the new trust model alone, JWT + scopes would be competitive again — but the agent-delegation pattern is central to the product and Biscuit's the cleanest fit. We confirmed (2026-05-17): **stay on Biscuit**.

## Revaluation triggers

We will reopen this ADR and consider switching if **any** of the following becomes true:

1. **`biscuit-auth-rs` or its WASM bindings stagnate** — defined as: no release in 12 months *and* unfixed CVE-worthy issue. → Switch to **Macaroons** (translation is 1:1).
2. **Team can't reason about Datalog caveats in code review** — defined as: more than three caveat-related bugs caught only in production within a quarter. → Switch to **Macaroons** with structured predicates, or **UCAN** with JSON capabilities.
3. **weaver gains self-hosted federation** (customer wants self-hosted peers sharing docs with the SaaS). → **UCAN** becomes the better fit (decentralized trust model is built-in).
4. **weaver gains wallet-based auth** for a Web3-adjacent customer. → **UCAN** + `did:key:` is the natural answer.
5. **Cloudflare ships a first-party capability primitive** that matches our shape. → Evaluate adoption.
6. **A customer demands SOC-audited credential format** and Biscuit lacks a public audit at the time. → **Macaroons** (longer track record) or a hybrid (JWT outer + custom inner).
7. **GNAP reaches RFC status with mature Rust+WASM bindings.** → Evaluate as a complement to Biscuit at the issuance layer.

## Consequences

### Immediate

- [`access-control.md`](../access-control.md) §2 references this ADR; the dual-token-pattern note added there.
- `@weaver/server/src/auth/capability.ts` ships the wrapper interface in Phase 0 alongside `BiscuitImpl`.
- `MacaroonImpl` shipped as a smoke test in Phase 0 (verifies the wrapper actually abstracts; not deployed) — gives us a real fallback in production.
- Property tests in Phase 0 cover both impls behind the wrapper.

### Downstream

- ADR 0004 is the canonical reference for "why this token format." Any plugin or feature spec that touches auth links here, not to a re-derivation.
- A switch is a wrapper-implementation change, not a call-site change.
- We document the dual-token pattern in onboarding so contributors don't conflate "the JWT" (session) with "the Biscuit" (capability).

### Reversibility

Cheap by design — the wrapper interface is the whole point. Cost of swap:

- Implement new wrapper (≈1 week for Macaroons, ≈2 weeks for UCAN given the principal-model translation work).
- Rotate signing keys.
- Drain old tokens (force re-auth on next session refresh).
- No call-site changes; no DO logic changes.

## References

- [Biscuit auth](https://www.biscuitsec.org)
- [Biscuit specification](https://github.com/biscuit-auth/biscuit)
- [Macaroons paper — Birgisson et al.](https://research.google/pubs/pub41892/)
- [UCAN spec](https://github.com/ucan-wg/spec)
- [UCAN working group](https://ucan.xyz)
- [GNAP IETF working group](https://datatracker.ietf.org/wg/gnap/about/)
- [PASETO](https://paseto.io)
- [Cedar policy language](https://www.cedarpolicy.com)
- ADR 0001 — Loro adoption — [`./0001-adopt-loro-over-yjs.md`](./0001-adopt-loro-over-yjs.md)
- ADR 0002 — Block model — [`./0002-notion-style-block-model.md`](./0002-notion-style-block-model.md)
- ADR 0003 — Concurrent semantics — [`./0003-concurrent-semantics-no-global-rw-aw.md`](./0003-concurrent-semantics-no-global-rw-aw.md)
- Access control deep dive — [`../access-control.md`](../access-control.md)
