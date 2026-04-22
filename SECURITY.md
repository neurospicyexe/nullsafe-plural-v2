# Security — nullsafe-plural-v2

## Reporting a Vulnerability

If you find a security vulnerability in this code, please report it privately before public disclosure. Open a GitHub security advisory on this repository or contact the maintainer directly. Do not post exploit details publicly until there has been a chance to patch. See the root [SECURITY.md](../SECURITY.md) for full context on this project's security posture.

---

This service bridges your SimplyPlural account with the companion system. It holds a SimplyPlural API token with read access to your front state.

See root `SECURITY.md` at `C:\dev\Bigger_Better_Halseth\SECURITY.md` for the full architecture overview and 2FA guidance.

---

## What's Protected Here

Your SimplyPlural data (system members, fronting history) is accessed via API token. The Worker itself stores nothing — it fetches live data and returns it. No fronting history is written here.

---

## Secrets Used by This Service

| Secret | Where | Risk if leaked |
|--------|-------|---------------|
| `SIMPLYPLURAL_TOKEN` | Wrangler secret (prod), `.dev.vars` (local) | Read access to your SimplyPlural system data |
| `ADMIN_SECRET` | Wrangler secret (prod), `.dev.vars` (local) | Auth for all API calls to this Worker |

---

## SimplyPlural Token Scope

Use the minimum scope needed. This service only needs **read** access to member and fronting data — it does not need write, admin, or notification access. Grant only what's required.

---

## If the SimplyPlural Token Is Compromised

1. Go to SimplyPlural → Settings → API Tokens
2. Revoke the token
3. Generate a new one with read-only scope
4. Update it in Wrangler: `npx wrangler secret put SIMPLYPLURAL_TOKEN`
