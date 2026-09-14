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
