## Security development

Standing rules for all agents working in this repo. Prefer risk-tiered secure coding over full-repo security audits on every change. Shared skill reference: Secure industrial coding (`secure-industrial-coding`).

- For auth, permissions, payments, background jobs, DB policies, sensitive data, or privileged ops: state allow vs deny before coding.
- TDD must cover illegal calls, forged input, and no side effects on reject (not only happy paths).
- Use the stack’s official guidance skill when applicable (e.g. Supabase for Auth/RLS/Edge Functions).
- Before claiming done: verification-before-completion — only claim what executed evidence shows (tests actually ran; lint ≠ fixed).
- Risk tiers: UI/copy = format + relevant tests + evidence; ordinary business = + TDD; Tier C (auth/payment/RLS/privileged API) = deny tests first + misuse-resistant design; differential review of this diff only before merge — not default full-repo audits.
- Never finish by deleting tests, weakening asserts, skipping typecheck, widening privileges, disabling protections, or touching production resources.
- Do not trust client-claimed payment, role, or membership flags; server must verify entitlement.

Daily default: platform official skill (when relevant) + test-driven-development + verification-before-completion. Sensitive changes additionally use sharp-edges (design) and differential-review (this PR/diff).

## Hard forbid list

Do not:

- Delete tests, skip tests, or weaken assertions to make CI green
- Bypass or skip typecheck / lint as a way to merge
- Put secrets (BYOK keys, exchange credentials, tokens) in client bundles, commits, prompts, or logs
- Use production credentials in development, CI, or agent environments
- Trust client-claimed privileges (role, membership, payment, “admin”, or “I already have market history”)
- Run a full-repo security audit for UI/copy changes

## Tier C dual evidence (required before merge)

Tier C here means BYOK / API keys, market-data credentials, privileged backend fetches, auth/session if added, or eval/exec of untrusted Pine in tooling.

Before merge, the PR must include **both**:

1. **Deny-path evidence** — tests (or a recorded CI run of existing tests) covering illegal calls, forged input, and no side effects on reject
2. **Trust-boundary note** — which server/backend helper or route enforces allow vs deny (file path + one sentence)

UI/copy (Tier A) does not need dual evidence; Agent + CI is enough. Do not expand review into a full-repo audit.

## Platform skills (this repo)

This tree is a Pine transpiler plus Trading Hub studio. It does **not** use Supabase. Do not load a Supabase Auth/RLS/Edge pack unless the tree actually gains Supabase.

Daily default:

- test-driven-development
- verification-before-completion

Tier C additionally:

- sharp-edges (design: allow vs deny before coding)
- differential-review of **this diff only** (not a full-repo audit)

Sensitive domain: **BYOK, user-supplied API keys, and market-data credentials**. Keys must never be logged, echoed in model prompts/errors, or committed. Market-data access is public-exchange fetch via existing backend helpers — not a client-claimed screenshot or candle dump.

## Capability boundary

Market-data keys and privileged backend fetches must not be reachable from untrusted renderer/client paths. Prefer existing protected server/backend helpers:

- `studio/app/api/klines/route.ts`, `studio/app/api/markets/route.ts`, `studio/app/api/cvd/route.ts`, `studio/app/api/derivatives/route.ts`
- `studio/lib/market-rest.ts`, `studio/lib/market-cvd.ts`, `studio/lib/market-derivatives.ts`
- `studio/app/api/ai/analyze/route.ts` + `studio/lib/ai-context.ts` + `studio/lib/ai/proxy.ts`

Client-supplied candles, screenshots, or “I already packed history” flags are not entitlement. The analyze route assembles klines / OI / CVD / history packs on the server.

## References

- [Threat models](docs/security/threat-models.md)
- [Human review checklist](docs/security/human-review-checklist.md)
