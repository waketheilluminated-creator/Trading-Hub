# Human review checklist

Human review is for **trust boundaries only**. UI/copy and ordinary studio layout can rely on Agent + CI.

Review a change in this list when the diff touches any of:

1. **Keys / secrets** — BYOK storage, `rememberKey`, redaction, proxy `Authorization` headers, exchange credentials if added.
2. **Auth / session** — any new login, cookie, or server session (none today). BYOK `sessionStorage` counts. Drawing session does not.
3. **Privileged market-data access** — new fetches outside `studio/app/api/*` / `studio/lib/market-*.ts`; client-assembled Context Packs; screenshot/scroll-capture paths; treating client candles as history.
4. **Unsafe eval/exec in tooling** — `eval`, `new Function`, dynamic `import()` of generated JS, `child_process`, or file writes from untrusted Pine/filenames (`src/reviewer.js`, CLI, pine-paster).

## What to confirm (Tier C)

- Allow vs deny is explicit; illegal/forged input has a test; reject has no side effects (no fetch, no key persist, no file write).
- Secrets never appear in logs, prompts, error JSON, or git.
- Market-data keys and privileged backend fetches are not reachable from untrusted renderer/client paths.
- Dual evidence is in the PR: deny-path evidence + trust-boundary note (see `AGENTS.md`).
- Review is **this diff only** — not a full-repo audit.

## Skip human security review

Tier A UI/copy, chart chrome, and docs that do not move keys, auth, privileged fetches, or eval/exec. Agent + CI is enough.
