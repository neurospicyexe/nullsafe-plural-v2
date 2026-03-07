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
- Claude Desktop: use `mcp-remote` proxy pointing to `https://nullsafe-plural-v2.<account>.workers.dev/mcp`
- Cloudflare AI Playground: enter the `/mcp` URL directly
