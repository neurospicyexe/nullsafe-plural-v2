# Installing nullsafe-plural-v2

> **Tech-savvy?** The quick version is in [README.md](./README.md). This guide is for everyone else.

## What is this, in plain English?

This connects your [SimplyPlural](https://apparyllis.com) account to Claude. Once set up, Claude can see who is currently fronting, check front history, and log front changes — all through natural conversation.

It runs on **Cloudflare Workers** — Cloudflare's free serverless platform. No server required. It stays online 24/7.

---

## What you need

- **A Cloudflare account** (free) — [cloudflare.com](https://cloudflare.com)
- **A SimplyPlural account** — [apparyllis.com](https://apparyllis.com) — and your API token
- **Node.js** installed — [nodejs.org](https://nodejs.org) (LTS version)
- **Git** — [git-scm.com](https://git-scm.com)
- A terminal. On Windows: search "Terminal" or "PowerShell". On Mac: Spotlight → Terminal.

### Getting your SimplyPlural API token

1. Open the SimplyPlural app
2. Go to **Settings** → **API**
3. Create a new token — read-only scope is enough for most uses
4. Copy it somewhere safe

---

## Step 1 — Install Wrangler

```bash
npm install -g wrangler
wrangler login
```

A browser window opens — click Allow.

---

## Step 2 — Get the code

```bash
git clone https://github.com/neurospicyexe/nullsafe-plural-v2.git
cd nullsafe-plural-v2
npm install
```

---

## Step 3 — Set up Cloudflare KV

KV is Cloudflare's key-value store — it holds OAuth session state.

```bash
npx wrangler kv namespace create OAUTH_KV
```

Copy the `id` from the output. Open `wrangler.jsonc` and paste it:

```json
"kv_namespaces": [
  { "binding": "OAUTH_KV", "id": "paste-your-id-here" }
]
```

---

## Step 4 — Add your system members

Create `src/members.json` (this file is gitignored — it never gets committed):

```json
{
  "simplyplural-member-id-here": { "name": "MemberName", "pk": "their-pk-value" },
  "another-id": { "name": "AnotherName", "pk": "their-pk" }
}
```

Find member IDs in SimplyPlural under each member's profile. The `pk` value is their PluralKit ID if you use PluralKit, otherwise leave it as their name in lowercase.

---

## Step 5 — Set your SimplyPlural token

```bash
npx wrangler secret put SIMPLY_PLURAL_TOKEN
```

Paste your SimplyPlural API token when prompted.

---

## Step 6 — Deploy

```bash
npm run deploy
```

You'll see a URL like `nullsafe-plural-v2.neurospicyexe.workers.dev`. That's your worker.

---

## Step 7 — Connect Claude

Add to your Claude Desktop MCP config:

```json
{
  "mcpServers": {
    "Nullsafe-Plural-v2": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://nullsafe-plural-v2.neurospicyexe.workers.dev/mcp"]
    }
  }
}
```

The first time you open Claude after adding this, it will ask you to authorize via an OAuth flow — click through and allow it.

---

## Troubleshooting

| Error | Fix |
|-------|-----|
| `wrangler: command not found` | Run `npm install -g wrangler` again and restart your terminal |
| KV namespace error on deploy | Make sure you pasted the KV id into `wrangler.jsonc` |
| `Cannot read members.json` | Make sure you created `src/members.json` with the right format |
| SimplyPlural returns 401 | Your API token is wrong or expired — get a new one from the SimplyPlural app |
| OAuth loop in Claude | Clear the OAuth KV by going to Cloudflare dashboard → Workers & Pages → your worker → KV → clear all entries, then try again |
