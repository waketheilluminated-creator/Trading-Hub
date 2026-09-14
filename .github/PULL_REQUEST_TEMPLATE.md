## Risk tier

- [ ] **A** — UI/copy (Agent + CI)
- [ ] **B** — Ordinary business (TDD + evidence)
- [ ] **C** — Keys, auth, privileged market data, or eval/exec (dual evidence required)

## Summary

<!-- What changed and why. -->

## Tier C dual evidence (required if Tier C)

### Deny-path evidence

<!-- Test path or CI log covering illegal calls, forged input, and no side effects on reject. -->

### Trust-boundary note

<!-- File that enforces allow vs deny, plus one sentence. -->

## Links

- [Threat models](docs/security/threat-models.md)
- [Human review checklist](docs/security/human-review-checklist.md)

## Forbid-list reminder

I did **not**: delete or weaken tests; bypass typecheck; put secrets in client/commits/logs; use production credentials; trust client-claimed privileges; run a full-repo audit for UI.
