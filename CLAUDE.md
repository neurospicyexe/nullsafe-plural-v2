# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev          # Run locally with wrangler dev (localhost:8787)
npm run deploy       # Deploy to Cloudflare Workers
npm run type-check   # TypeScript type checking (tsc --noEmit)
npm run lint:fix     # Lint and auto-fix with oxlint
npm run format       # Format code with oxfmt
npm run cf-typegen   # Generate Cloudflare Workers types
```

## Ecosystem — Four Interworking Projects

Nullsafe-plural-v2 is one of four projects that form a suite. When making changes that cross boundaries, consult the adjacent project's CLAUDE.md and MCP tools.

| Project | Role |
|---------|------|
| **halseth** | Primary data backend — Cloudflare Worker + D1 + R2. Exposes HTTP endpoints and MCP tools (`mcp__claude_ai_Halseth__*`) |
| **hearth** | Next.js dashboard frontend. Reads halseth HTTP endpoints via `lib/halseth.ts`. Deployed on Vercel |
| **nullsafe-plural-v2** | Cloudflare Workers MCP for SimplyPlural (plural/fronting system). Exposes `mcp__claude_ai_Nullsafe-Plural-v2__*` tools |
| **nullsafe-second-brain** | Local Node.js MCP (stdio). Reads halseth + nullsafe-plural-v2 via HTTP, writes to Obsidian vault, maintains SQLite vector store for companion RAG |

Nullsafe-plural-v2 and halseth are independent backends that both surface data upward to hearth and second-brain. Second-brain is the synthesis/RAG layer that reads both.

## Architecture

This is a **Cloudflare Workers MCP server** that bridges Claude to a SimplyPlural (plural system tracking) account via the SimplyPlural REST API.

### Entry point: `src/index.ts`

The Worker exports a single default fetch handler backed by `OAuthProvider` from `@cloudflare/workers-oauth-provider`. The OAuth layer wraps the MCP agent and handles `/authorize`, `/token`, and `/register` endpoints, while routing `/mcp` to the agent.

**`NullsafePluralMCP`** extends `McpAgent` (from the `agents` package) and registers these tools:
- `get_current_front` — fetches live fronters from SimplyPlural
- `log_front_change` — creates/updates/closes front history entries
- `get_front_history` — retrieves recent front history
- `get_member` — resolves a member by any identifier
- `search_members` — fuzzy name search across the member map
- `add_member_note` — posts a note to a member's profile

### Member resolution (`resolveMemberInput`)

Members are stored in `src/members.json` as a static map of `{ [member_id]: { name, pk } }`. The resolver tries lookups in priority order: exact ID → exact pk → exact name → ID prefix → pk prefix → name prefix. Ambiguous prefix matches throw with a list of candidates. Always prefer passing a SimplyPlural `member_id` to avoid ambiguity.

### SimplyPlural API

All API calls go through `spRequest()` to `https://api.apparyllis.com/v1`. The auth token is read from the `SIMPLY_PLURAL_TOKEN` environment secret (set via `wrangler secret put SIMPLY_PLURAL_TOKEN`).

### Infrastructure bindings (wrangler.jsonc)

- **Durable Object**: `NullsafePluralMCP` bound as `MCP_OBJECT` (uses SQLite storage via `new_sqlite_classes` migration)
- **KV**: `OAUTH_KV` for OAuth state storage

### MCP endpoint

The server is accessible at `/mcp` (SSE transport). Connect via:
- Claude Desktop: use `mcp-remote` proxy pointing to `https://<your-worker>.workers.dev/mcp`
- Cloudflare AI Playground: enter the `/mcp` URL directly

## Security

Full OWASP + vibesec audit run 2026-03-09. Fixes applied 2026-03-09.

| Severity | Location | Issue |
|----------|----------|-------|
| ~~**High**~~ | `src/index.ts` | ✅ **Fixed** — XSS + CSRF + scope inflation all resolved by KV nonce pattern: OAuth params stored server-side on GET under `nonce:<uuid>` (10 min TTL), only the UUID embedded in the form, looked up and deleted on POST. Form no longer reflects any OAuth params into HTML. Security headers added to authorize page. |
| ~~**Medium**~~ | `src/index.ts` | ✅ **Fixed** — `get_front_history` limit clamped to 1–200 via Zod + Math.min. |
| ~~**Medium**~~ | `src/index.ts` | ✅ **Fixed** — `SIMPLY_PLURAL_TOKEN` startup check: throws on missing/non-string token. |
| ~~**Low**~~ | `src/index.ts` | ✅ **Fixed** — `spRequest` error body logged internally, only status code surfaced to callers. |
| ~~**Low**~~ | `package.json` | ✅ **Fixed** — `npm audit fix` applied; 3 high-severity vulnerabilities in `hono`, `@hono/node-server`, `express-rate-limit` resolved. |
| **Low** | `src/index.ts:361,372,389` | Open redirect contingent on OAuth library — `redirectUri` flows through `completeAuthorization` to `Response.redirect`. Safe only if `@cloudflare/workers-oauth-provider` validates against registered URIs. Monitor on library updates. |
| **Low** | Throughout `src/index.ts` | Pervasive `any` types on SimplyPlural API responses — no Zod schema validation. Low priority for a personal tool. |
| **Low** | No rate limiting | Tool calls have no per-minute limits. A runaway MCP client can exhaust SimplyPlural API quota. |
