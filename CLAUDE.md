# nullsafe-plural-v2

Cloudflare Workers MCP server that bridges Claude to a [SimplyPlural](https://apparyllis.com) account via the SimplyPlural REST API. Surfaces fronting state, member lookup, and front history as MCP tools for use by companions and Claude Code.

Part of the BBH suite — see root `CLAUDE.md` for cross-project context.

## Commands

```bash
npm run dev          # Run locally with wrangler dev (localhost:8787)
npm run deploy       # Deploy to Cloudflare Workers
npm run type-check   # TypeScript type checking (tsc --noEmit)
npm run lint:fix     # Lint and auto-fix with oxlint
npm run format       # Format code with oxfmt
npm run cf-typegen   # Generate Cloudflare Workers types
```

## Architecture

This is a **Cloudflare Workers MCP server** built on `@cloudflare/workers-oauth-provider`.

### Entry point: `src/index.ts`

The Worker exports a fetch handler backed by `OAuthProvider`. The OAuth layer wraps the MCP agent and handles `/authorize`, `/token`, and `/register` endpoints, while routing `/mcp` to the agent.

**`NullsafePluralMCP`** extends `McpAgent` and registers these tools:

| Tool | Description |
|------|-------------|
| `get_current_front` | Fetches live fronters from SimplyPlural |
| `log_front_change` | Creates/updates/closes front history entries |
| `get_front_history` | Retrieves recent front history |
| `get_member` | Resolves a member by any identifier |
| `search_members` | Fuzzy name search across the member map |
| `add_member_note` | Posts a note to a member's profile |

### Member resolution (`resolveMemberInput`)

Members are stored in `src/members.json` as a static map of `{ [member_id]: { name, pk } }`. The resolver tries lookups in priority order: exact ID → exact pk → exact name → ID prefix → pk prefix → name prefix. Ambiguous prefix matches throw with a list of candidates. Always prefer passing a SimplyPlural `member_id` to avoid ambiguity.

### SimplyPlural API

All API calls go through `spRequest()` to `https://api.apparyllis.com/v1`. The auth token is read from the `SIMPLY_PLURAL_TOKEN` environment secret (set via `wrangler secret put SIMPLY_PLURAL_TOKEN`).

### Infrastructure bindings (`wrangler.jsonc`)

- **Durable Object**: `NullsafePluralMCP` bound as `MCP_OBJECT` (SQLite storage via `new_sqlite_classes` migration)
- **KV**: `OAUTH_KV` for OAuth state storage

### Connecting

The server is accessible at `/mcp` (SSE transport):
- **Claude Desktop**: use `mcp-remote` proxy pointing to `https://<your-worker>.workers.dev/mcp`
- **Cloudflare AI Playground**: enter the `/mcp` URL directly

## Security

Full OWASP + vibesec audit completed. Open findings: `docs/security-audit.md`

| Severity | Location | Status |
|----------|----------|--------|
| ~~High~~ | `src/index.ts` | Fixed — XSS + CSRF + scope inflation resolved via KV nonce pattern. OAuth params stored server-side under a UUID (10 min TTL); only the UUID is embedded in the form. |
| ~~Medium~~ | `src/index.ts` | Fixed — `get_front_history` limit clamped to 1–200 via Zod + Math.min. |
| ~~Medium~~ | `src/index.ts` | Fixed — `SIMPLY_PLURAL_TOKEN` startup check throws on missing/non-string token. |
| ~~Low~~ | `src/index.ts` | Fixed — `spRequest` error body logged internally; only status code surfaced to callers. |
| ~~Low~~ | `package.json` | Fixed — `npm audit fix` applied; high-severity vulnerabilities in dependencies resolved. |
| Low | `src/index.ts` | Open redirect contingent on OAuth library — `redirectUri` flows through `completeAuthorization`. Safe if `@cloudflare/workers-oauth-provider` validates against registered URIs. Monitor on library updates. |
| Low | Throughout | Pervasive `any` types on SimplyPlural API responses; no Zod schema validation. Accepted for lean phase. |
| Low | No rate limiting | Tool calls have no per-minute limits; a runaway client could exhaust SimplyPlural API quota. |
