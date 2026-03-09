# nullsafe-plural-v2

Connects Claude to your [SimplyPlural](https://www.apparyllis.com) account so companions can read and log front state, check who's fronting, view member profiles, and add notes — all through natural conversation.

Runs as a Cloudflare Worker on the free tier.

---

> **⚠️ Disclaimer**
> This project was built with AI assistance ("vibe-coded"). Security hardening has been applied to the best of our ability — OAuth 2.0 with PKCE, CSRF protection, input validation — but this software comes with **no warranty and no liability**. It has not undergone a professional security audit. If you use it, you use it at your own risk.

---

## What you need before starting

- A free [Cloudflare account](https://dash.cloudflare.com/sign-up)
- A [SimplyPlural](https://www.apparyllis.com) account
- [Node.js](https://nodejs.org) installed (LTS version is fine)
- Basic comfort with a terminal

---

## Setup — step by step

### 1. Clone and install

```bash
git clone https://github.com/your-username/nullsafe-plural-v2
cd nullsafe-plural-v2
npm install
```

### 2. Log in to Cloudflare

```bash
npx wrangler login
```

Opens a browser — log in and come back to the terminal.

### 3. Create your KV namespace

This is where OAuth session data is stored.

```bash
npx wrangler kv namespace create OAUTH_KV
```

Copy the `id` it prints out.

### 4. Set up your production config

```bash
cp wrangler.jsonc wrangler.prod.jsonc
```

Open `wrangler.prod.jsonc` and replace `REPLACE_WITH_KV_NAMESPACE_ID` with the ID you copied above.

> `wrangler.prod.jsonc` is gitignored — your real IDs will never be pushed to GitHub.

### 5. Add your member data

`src/members.json` maps SimplyPlural member IDs to names. This file is **gitignored** (it contains your system's member list).

Create it manually or export it from SimplyPlural. Format:

```json
{
  "simplyplural-member-id-here": { "name": "MemberName", "pk": "their-pk-value" },
  "another-member-id": { "name": "AnotherName", "pk": "their-pk" }
}
```

You can find member IDs in the SimplyPlural app under each member's profile.

### 6. Set your SimplyPlural token

```bash
npx wrangler secret put SIMPLY_PLURAL_TOKEN --config wrangler.prod.jsonc
```

Paste your SimplyPlural API token when prompted. Find it in the SimplyPlural app under **Settings → API**.

### 7. Deploy

```bash
npm run deploy
```

It prints a URL like `https://nullsafe-plural-v2.your-account.workers.dev`. That's your MCP server.

---

## Connecting to Claude

In Claude Desktop, go to **Settings → Developer → Edit Config** and add:

```json
{
  "mcpServers": {
    "nullsafe-plural": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://nullsafe-plural-v2.your-account.workers.dev/mcp"
      ]
    }
  }
}
```

Restart Claude. The first connection opens a browser to authorize — just click Approve.

---

## What Claude can do with this

| Tool | What it does |
|------|-------------|
| `get_current_front` | Who's fronting right now |
| `get_front_history` | Recent front history |
| `log_front_change` | Log that someone started or stopped fronting |
| `get_member` | Look up a member by name, ID, or nickname |
| `search_members` | Search members by partial name |
| `add_member_note` | Add a note to a member's SimplyPlural profile |

---

## Part of a suite

| Project | What it does |
|---------|-------------|
| [Halseth](https://github.com/your-username/halseth) | Companion memory and session backend |
| [Hearth](https://github.com/your-username/hearth) | Visual dashboard |
| [nullsafe-second-brain](https://github.com/your-username/nullsafe-second-brain) | Obsidian vault + semantic memory |
