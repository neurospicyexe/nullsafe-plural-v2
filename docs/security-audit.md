# Nullsafe-Plural-v2 Security Audit

OWASP + vibesec audit run 2026-03-09. Fixes applied same day.
Completed findings are not tracked here -- they're in git history.

## Open Findings

| Severity | Location | Issue |
|----------|----------|-------|
| LOW | `src/index.ts:361,372,389` | Open redirect contingent on OAuth library -- `redirectUri` flows through `completeAuthorization`. Safe only if `@cloudflare/workers-oauth-provider` validates against registered URIs. Monitor on library updates. |
| LOW | Throughout `src/index.ts` | Pervasive `any` types on SimplyPlural API responses -- no Zod schema validation. Low priority for a personal tool. |
| LOW | Global | No per-minute rate limiting on tool calls. A runaway MCP client can exhaust SimplyPlural API quota. |
