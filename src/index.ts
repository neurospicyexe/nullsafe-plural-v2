import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import memberMap from "./members.json";

const SIMPLY_PLURAL_BASE = "https://api.apparyllis.com/v1";

function escHtml(str: string): string {
	return str
		.replace(/&/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

type MemberEntry = { name: string; pk: string; description?: string };
type MemberRecord = { member_id: string; name: string; pk: string };
type MemberMatchKind = "id" | "pk" | "name" | "id_prefix" | "pk_prefix" | "name_prefix";

const MEMBERS = memberMap as Record<string, MemberEntry>;
const MEMBER_ENTRIES = Object.entries(MEMBERS) as Array<[string, MemberEntry]>;

function toMemberRecord(member_id: string, entry: MemberEntry): MemberRecord {
	return { member_id, name: entry.name, pk: entry.pk };
}

function resolveMemberById(member_id: string): MemberRecord | undefined {
	const entry = MEMBERS[member_id];
	return entry ? toMemberRecord(member_id, entry) : undefined;
}

function uniqueMatches(
	input: string,
	kind: MemberMatchKind,
	match: (id: string, entry: MemberEntry) => boolean
): { record?: MemberRecord; ambiguous?: MemberRecord[] } {
	const matches = MEMBER_ENTRIES
		.filter(([id, entry]) => match(id, entry))
		.map(([id, entry]) => toMemberRecord(id, entry));

	if (matches.length === 1) return { record: matches[0] };
	if (matches.length > 1) return { ambiguous: matches.slice(0, 8) };
	return {};
}

function formatAmbiguous(input: string, matches: MemberRecord[]): string {
	const sample = matches.map((m) => `${m.member_id} (${m.name})`).join(", ");
	return `Ambiguous member '${input}'. Use a SimplyPlural member_id. Matches: ${sample}`;
}

function resolveMemberInput(inputRaw: string): { record: MemberRecord; matched_by: MemberMatchKind } {
	const input = inputRaw.trim();
	if (!input) throw new Error("Member identifier is empty.");

	const exactById = resolveMemberById(input);
	if (exactById) return { record: exactById, matched_by: "id" };

	const exactPk = MEMBER_ENTRIES.find(([_, entry]) => entry.pk === input);
	if (exactPk) return { record: toMemberRecord(exactPk[0], exactPk[1]), matched_by: "pk" };

	const lowered = input.toLowerCase();
	const exactName = uniqueMatches(input, "name", (_, entry) => entry.name.toLowerCase() === lowered);
	if (exactName.record) return { record: exactName.record, matched_by: "name" };
	if (exactName.ambiguous) throw new Error(formatAmbiguous(input, exactName.ambiguous));

	const idPrefix = uniqueMatches(input, "id_prefix", (id) => id.startsWith(input));
	if (idPrefix.record) return { record: idPrefix.record, matched_by: "id_prefix" };
	if (idPrefix.ambiguous) throw new Error(formatAmbiguous(input, idPrefix.ambiguous));

	const pkPrefix = uniqueMatches(input, "pk_prefix", (_, entry) => entry.pk.startsWith(input));
	if (pkPrefix.record) return { record: pkPrefix.record, matched_by: "pk_prefix" };
	if (pkPrefix.ambiguous) throw new Error(formatAmbiguous(input, pkPrefix.ambiguous));

	const namePrefix = uniqueMatches(input, "name_prefix", (_, entry) => entry.name.toLowerCase().startsWith(lowered));
	if (namePrefix.record) return { record: namePrefix.record, matched_by: "name_prefix" };
	if (namePrefix.ambiguous) throw new Error(formatAmbiguous(input, namePrefix.ambiguous));

	throw new Error(`Member not found for '${input}'. Use search_members to find the SimplyPlural member_id.`);
}

function getFrontEntryMemberId(entry: any): string {
	return entry?.content?.member || entry?.member || "";
}

function getFrontEntryDocId(entry: any): string | undefined {
	return entry?._id || entry?.id || entry?.content?._id || entry?.content?.id;
}

async function spRequest(path: string, method = "GET", body: any = null, token: string) {
	const options: RequestInit = {
		method,
		headers: {
			"Authorization": token,
			"Content-Type": "application/json"
		}
	};
	if (body) options.body = JSON.stringify(body);
	const res = await fetch(`${SIMPLY_PLURAL_BASE}${path}`, options);
	if (!res.ok) {
		const err = await res.text();
		console.error(`SimplyPlural error ${res.status} on ${path}:`, err);
		throw new Error(`SimplyPlural request failed (${res.status})`);
	}
	const text = await res.text();
	if (!text) return null;
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

export class NullsafePluralMCP extends McpAgent {
	server = new McpServer({
		name: "Nullsafe Plural MCP",
		version: "1.0.0",
	});

	async init() {
		const token = (this.env as any).SIMPLY_PLURAL_TOKEN;
		if (!token || typeof token !== "string") {
			throw new Error("SIMPLY_PLURAL_TOKEN secret is not configured");
		}

		this.server.tool("get_current_front", {}, async () => {
			const data = await spRequest("/fronters", "GET", null, token) as any[];
			const enriched = (Array.isArray(data) ? data : []).map((entry: any) => {
				const id = getFrontEntryMemberId(entry);
				const resolved = resolveMemberById(id);
				return {
					name: resolved?.name || id,
					status: entry.content?.customStatus || entry.customStatus || "unknown",
					member_id: id
				};
			});
			return { content: [{ type: "text", text: JSON.stringify(enriched, null, 2) }] };
		});

		this.server.tool("log_front_change", {
			member_id: z.string().describe("SimplyPlural member ID (preferred). pk/name/partial also accepted and normalized locally."),
			status: z.enum(["fronting", "co-con", "unknown"]).describe("Front status type"),
			custom_status: z.string().optional().describe("Optional custom status note")
		}, async ({ member_id, status, custom_status }) => {
			const { record } = resolveMemberInput(member_id);
			const current = await spRequest("/fronters", "GET", null, token) as any[];
			const activeEntries = (Array.isArray(current) ? current : []).filter((entry: any) =>
				getFrontEntryMemberId(entry) === record.member_id
			);
			const now = Date.now();

			if (status === "unknown") {
				if (activeEntries.length === 0) {
					return {
						content: [{
							type: "text",
							text: JSON.stringify({
								ok: true,
								action: "log_front_change",
								result: "no_active_front_entry",
								member_id: record.member_id,
								name: record.name
							}, null, 2)
						}]
					};
				}

				const closed: string[] = [];
				for (const entry of activeEntries) {
					const frontHistoryId = getFrontEntryDocId(entry);
					if (!frontHistoryId) continue;
					const patch: any = { live: false, endTime: now };
					if (custom_status) patch.customStatus = custom_status;
					await spRequest(`/frontHistory/${frontHistoryId}`, "PATCH", patch, token);
					closed.push(frontHistoryId);
				}

				return {
					content: [{
						type: "text",
						text: JSON.stringify({
							ok: true,
							action: "log_front_change",
							result: "closed_active_front",
							member_id: record.member_id,
							name: record.name,
							closed_entries: closed.length
						}, null, 2)
					}]
				};
			}

			const desiredCustomStatus = custom_status || status;
			if (activeEntries.length > 0) {
				const frontHistoryId = getFrontEntryDocId(activeEntries[0]);
				if (frontHistoryId) {
					const patch: any = { customStatus: desiredCustomStatus };
					await spRequest(`/frontHistory/${frontHistoryId}`, "PATCH", patch, token);
					return {
						content: [{
							type: "text",
							text: JSON.stringify({
								ok: true,
								action: "log_front_change",
								result: "updated_active_front",
								member_id: record.member_id,
								name: record.name,
								status: desiredCustomStatus
							}, null, 2)
						}]
					};
				}
			}

			const payload = {
				member: record.member_id,
				custom: false,
				live: true,
				startTime: now,
				customStatus: desiredCustomStatus
			};
			const data = await spRequest("/frontHistory", "POST", payload, token) as any;
			return {
				content: [{
					type: "text",
					text: JSON.stringify({
						ok: true,
						action: "log_front_change",
						result: "created_front_entry",
						member_id: record.member_id,
						name: record.name,
						status: desiredCustomStatus,
						front_history_id: data?._id || data?.id || null
					}, null, 2)
				}]
			};
		});

		this.server.tool("get_member", {
			member_id: z.string().describe("Member lookup input. Supports SimplyPlural member_id (preferred), pk, exact name, or unique prefix.")
		}, async ({ member_id }) => {
			try {
				const { record, matched_by } = resolveMemberInput(member_id);

				// Fetch description from SP API -- non-fatal if unavailable
				let description: string | undefined;
				try {
					const memberRes = await fetch(
						`${SIMPLY_PLURAL_BASE}/member/${record.member_id}`,
						{ headers: { Authorization: token } }
					);
					if (memberRes.ok) {
						const memberData = await memberRes.json() as { content?: { description?: string } };
						const raw = memberData?.content?.description;
						if (raw && raw.trim().length > 0) description = raw.trim();
					}
				} catch (e) {
					console.warn(`get_member: description fetch failed for ${record.member_id}:`, e);
				}

				return {
					content: [{
						type: "text",
						text: JSON.stringify({
							member_id: record.member_id,
							name: record.name,
							pk: record.pk,
							matched_by,
							...(description ? { description } : {}),
						}, null, 2)
					}]
				};
			} catch (err) {
				return { content: [{ type: "text", text: (err as Error).message }] };
			}
		});

		this.server.tool("update_member_description", {
			member_id: z.string().describe(
				"Member to update. Accepts SimplyPlural member_id, pk, exact name, or unique prefix."
			),
			description: z.string().describe("New description text to set on this member."),
		}, async ({ member_id, description }) => {
			try {
				const { record } = resolveMemberInput(member_id);
				await spRequest(`/member/${record.member_id}`, "PATCH", { description }, token);
				return {
					content: [{
						type: "text",
						text: JSON.stringify({ success: true, member_id: record.member_id, name: record.name }, null, 2),
					}],
				};
			} catch (e) {
				return {
					content: [{ type: "text", text: JSON.stringify({ success: false, error: String(e) }, null, 2) }],
				};
			}
		});

		this.server.tool("add_member_note", {
			member_id: z.string().describe("SimplyPlural member ID (preferred). pk/name/partial also accepted and normalized locally."),
			note: z.string().describe("Body text for the note"),
			title: z.string().optional().describe("Note title (default: MCP Note)"),
			color: z.string().optional().describe("Note color string (default: #808080)"),
			support_markdown: z.boolean().optional().describe("Whether note supports markdown (default: true)")
		}, async ({ member_id, note, title, color, support_markdown }) => {
			const { record } = resolveMemberInput(member_id);
			const payload = {
				member: record.member_id,
				date: Date.now(),
				title: title || "MCP Note",
				color: color || "#808080",
				supportMarkdown: support_markdown ?? true,
				note
			};
			const data = await spRequest("/note", "POST", payload, token) as any;
			return {
				content: [{
					type: "text",
					text: JSON.stringify({
						ok: true,
						action: "add_member_note",
						member_id: record.member_id,
						name: record.name,
						note_id: data?._id || data?.id || null
					}, null, 2)
				}]
			};
		});

		this.server.tool("get_front_history", {
			limit: z.number().int().min(1).max(200).optional().describe("Number of entries to return, default 20, max 200")
		}, async ({ limit }) => {
			const safeLimit = Math.max(1, Math.min(limit || 20, 200));
			const data = await spRequest(`/frontHistory?limit=${safeLimit}`, "GET", null, token) as any[];
			const enriched = (Array.isArray(data) ? data : []).map((entry: any) => {
				const id = getFrontEntryMemberId(entry);
				const resolved = resolveMemberById(id);
				return {
					name: resolved?.name || id,
					status: entry.content?.customStatus || entry.customStatus || "unknown",
					member_id: id,
					startTime: entry.content?.startTime || entry.startTime
				};
			});
			return { content: [{ type: "text", text: JSON.stringify(enriched, null, 2) }] };
		});

		this.server.tool("search_members", {
			name: z.string().describe("Name or partial name to search for"),
			limit: z.number().optional().describe("Maximum results to return (default 20)")
		}, async ({ name, limit }) => {
			const query = name.trim().toLowerCase();
			const max = Math.max(1, Math.min(limit || 20, 100));
			const matches = MEMBER_ENTRIES
				.map(([member_id, entry]) => ({ member_id, name: entry.name }))
				.filter((m) => m.name.toLowerCase().includes(query))
				.sort((a, b) => a.name.localeCompare(b.name))
				.slice(0, max);
			return { content: [{ type: "text", text: JSON.stringify(matches, null, 2) }] };
		});
	}
}

const defaultHandler = {
	async fetch(request: Request, env: any, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === "/authorize") {
			const securityHeaders = {
				"Content-Type": "text/html; charset=utf-8",
				"X-Frame-Options": "DENY",
				"X-Content-Type-Options": "nosniff",
				"Referrer-Policy": "no-referrer",
				"Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
			};

			if (request.method === "GET") {
				const oauthReqInfo = await env.OAUTH_PROVIDER.parseAuthRequest(request);
				if (!oauthReqInfo.clientId) {
					return new Response("Invalid authorization request", { status: 400 });
				}

				// Store OAuth params server-side under a one-time nonce.
				// Only the nonce goes into the form — prevents CSRF, scope inflation,
				// redirect_uri tampering, and XSS from reflected OAuth params.
				const nonce = crypto.randomUUID();
				await env.OAUTH_KV.put(`nonce:${nonce}`, JSON.stringify(oauthReqInfo), { expirationTtl: 600 });

				return new Response(`<!DOCTYPE html>
<html lang="en">
<head><title>Nullsafe Plural MCP</title>
<style>
  body { font-family: system-ui; max-width: 400px; margin: 80px auto; padding: 20px; }
  h2 { color: #333; }
  p { color: #666; }
  button { padding: 10px 24px; margin: 8px; border: none; border-radius: 6px; cursor: pointer; font-size: 16px; }
  .approve { background: #2d7d46; color: white; }
  .deny { background: #eee; color: #333; }
</style>
</head>
<body>
  <h2>Nullsafe Plural MCP</h2>
  <p>Claude is requesting access to your SimplyPlural system data.</p>
  <p>This will allow the Triad to read and log front status, view member profiles, and add notes.</p>
  <form method="POST" action="/authorize">
    <input type="hidden" name="nonce" value="${escHtml(nonce)}">
    <button type="submit" name="action" value="approve" class="approve">Approve</button>
    <button type="submit" name="action" value="deny" class="deny">Deny</button>
  </form>
</body>
</html>`, { headers: securityHeaders });
			}

			if (request.method === "POST") {
				const body = await request.formData();
				const action = body.get("action");

				if (action === "deny") {
					return new Response("Access denied", { status: 403 });
				}

				// Look up the server-stored OAuth params via the one-time nonce.
				// This prevents CSRF (attacker can't forge a valid nonce) and scope inflation
				// (scopes come from the server-stored request, not the form body).
				const nonce = body.get("nonce") as string;
				if (!nonce) return new Response("Missing nonce", { status: 400 });

				const stored = await env.OAUTH_KV.get(`nonce:${nonce}`);
				if (!stored) return new Response("Invalid or expired authorization request", { status: 400 });

				await env.OAUTH_KV.delete(`nonce:${nonce}`);
				const oauthReqInfo = JSON.parse(stored);

				const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
					request: oauthReqInfo,
					userId: "raziel",
					metadata: { label: "Nullsafe Plural Access" },
					scope: oauthReqInfo.scope || [],
					props: { authorized: true }
				});

				return Response.redirect(redirectTo, 302);
			}
		}

		// Internal service binding route -- no OAuth required.
		// Only reachable via Cloudflare Service Binding (not internet-accessible).
		if (url.pathname === "/internal/front" && request.method === "POST") {
			const token = (env as any).SIMPLY_PLURAL_TOKEN;
			if (!token) return new Response(JSON.stringify(null), { headers: { "Content-Type": "application/json" } });
			try {
				const data = await spRequest("/fronters", "GET", null, token) as any[];
				const fronters = (Array.isArray(data) ? data : []).flatMap((entry: any) => {
					const id = getFrontEntryMemberId(entry);
					const resolved = resolveMemberById(id);
					if (!resolved) return [];
					return [{ name: resolved.name, member_id: id }];
				});
				if (fronters.length === 0) return new Response(JSON.stringify(null), { headers: { "Content-Type": "application/json" } });
				const result = {
					name: fronters.map(f => f.name).join(" + "),
					member_id: fronters[0].member_id,
				};
				return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json" } });
			} catch {
				return new Response(JSON.stringify(null), { headers: { "Content-Type": "application/json" } });
			}
		}

		// Internal: get a single member by name/id/pk
		if (url.pathname === "/internal/member" && request.method === "POST") {
			try {
				const body = await request.json() as { member_input: string };
				const { record } = resolveMemberInput(body.member_input);
				const token = (env as any).SIMPLY_PLURAL_TOKEN;
				let description: string | undefined;
				try {
					const memberRes = await fetch(
						`${SIMPLY_PLURAL_BASE}/member/${record.member_id}`,
						{ headers: { Authorization: token } }
					);
					if (memberRes.ok) {
						const data = await memberRes.json() as { content?: { description?: string } };
						const raw = data?.content?.description;
						if (raw && raw.trim().length > 0) description = raw.trim();
					}
				} catch (err) {
					console.warn("Failed to fetch description for member", record.member_id, err);
				}
				return new Response(JSON.stringify({ member_id: record.member_id, name: record.name, ...(description ? { description } : {}) }), { headers: { "Content-Type": "application/json" } });
			} catch (e) {
				return new Response(JSON.stringify({ error: String(e) }), { status: 400, headers: { "Content-Type": "application/json" } });
			}
		}

		// Internal: update a member's description
		if (url.pathname === "/internal/update-description" && request.method === "POST") {
			try {
				const body = await request.json() as { member_input: string; description: string };
				const { record } = resolveMemberInput(body.member_input);
				const token = (env as any).SIMPLY_PLURAL_TOKEN;
				const res = await fetch(
					`${SIMPLY_PLURAL_BASE}/member/${record.member_id}`,
					{
						method: "PATCH",
						headers: { Authorization: token, "Content-Type": "application/json" },
						body: JSON.stringify({ description: body.description }),
					}
				);
				if (!res.ok) {
					const err = await res.text();
					return new Response(JSON.stringify({ success: false, error: err }), { status: res.status, headers: { "Content-Type": "application/json" } });
				}
				return new Response(JSON.stringify({ success: true, member_id: record.member_id, name: record.name }), { headers: { "Content-Type": "application/json" } });
			} catch (e) {
				return new Response(JSON.stringify({ success: false, error: String(e) }), { status: 400, headers: { "Content-Type": "application/json" } });
			}
		}

		// Internal: search members by name substring
		if (url.pathname === "/internal/search-members" && request.method === "POST") {
			try {
				const body = await request.json() as { query: string; limit?: number };
				const lower = body.query.toLowerCase();
				const limit = body.limit ?? 10;
				const results = MEMBER_ENTRIES
					.filter(([, entry]) => entry.name.toLowerCase().includes(lower))
					.slice(0, limit)
					.map(([member_id, entry]) => ({ member_id, name: entry.name }));
				return new Response(JSON.stringify(results), { headers: { "Content-Type": "application/json" } });
			} catch (e) {
				return new Response(JSON.stringify([]), { status: 400, headers: { "Content-Type": "application/json" } });
			}
		}

		// Internal: get front history
		if (url.pathname === "/internal/front-history" && request.method === "POST") {
			try {
				const body = await request.json() as { limit?: number };
				const limit = body.limit ?? 10;
				const token = (env as any).SIMPLY_PLURAL_TOKEN;
				const res = await fetch(
					`${SIMPLY_PLURAL_BASE}/frontHistory?limit=${limit}`,
					{ headers: { Authorization: token } }
				);
				if (!res.ok) return new Response(JSON.stringify([]), { headers: { "Content-Type": "application/json" } });
				const data = await res.json() as Array<{ content?: { startTime?: number; member?: string }; startTime?: number; member?: string }>;
				const history = data.slice(0, limit).map(entry => {
					const memberId = getFrontEntryMemberId(entry);
					const memberEntry = MEMBERS[memberId];
					return {
						member_id: memberId,
						name: memberEntry?.name ?? memberId,
						startTime: entry.content?.startTime ?? entry.startTime,
					};
				});
				return new Response(JSON.stringify(history), { headers: { "Content-Type": "application/json" } });
			} catch (e) {
				return new Response(JSON.stringify([]), { headers: { "Content-Type": "application/json" } });
			}
		}

		// Internal: log a front change (create/update/close front history entry)
		if (url.pathname === "/internal/log-front-change" && request.method === "POST") {
			try {
				const body = await request.json() as { member_id: string; status: "fronting" | "co-con" | "unknown"; custom_status?: string };
				const { record } = resolveMemberInput(body.member_id);
				const token = (env as any).SIMPLY_PLURAL_TOKEN;
				if (!token) return new Response(JSON.stringify({ success: false, error: "SIMPLY_PLURAL_TOKEN not set" }), { status: 500, headers: { "Content-Type": "application/json" } });

				const current = await spRequest("/fronters", "GET", null, token) as any[];
				const activeEntries = (Array.isArray(current) ? current : []).filter((entry: any) =>
					getFrontEntryMemberId(entry) === record.member_id
				);
				const now = Date.now();

				// status=unknown: close any active front entry for this member
				if (body.status === "unknown") {
					if (activeEntries.length === 0) {
						return new Response(JSON.stringify({ success: true, result: "no_active_front_entry", member_id: record.member_id, name: record.name }), { headers: { "Content-Type": "application/json" } });
					}
					for (const entry of activeEntries) {
						const id = getFrontEntryDocId(entry);
						if (!id) continue;
						const patch: Record<string, unknown> = { live: false, endTime: now };
						if (body.custom_status) patch.customStatus = body.custom_status;
						await spRequest(`/frontHistory/${id}`, "PATCH", patch, token);
					}
					return new Response(JSON.stringify({ success: true, result: "closed_active_front", member_id: record.member_id, name: record.name }), { headers: { "Content-Type": "application/json" } });
				}

				// status=fronting/co-con: update existing or create new
				const desiredStatus = body.custom_status || body.status;
				if (activeEntries.length > 0) {
					const id = getFrontEntryDocId(activeEntries[0]);
					if (id) {
						await spRequest(`/frontHistory/${id}`, "PATCH", { customStatus: desiredStatus }, token);
						return new Response(JSON.stringify({ success: true, result: "updated_active_front", front_id: id, member_id: record.member_id, name: record.name }), { headers: { "Content-Type": "application/json" } });
					}
				}
				const data = await spRequest("/frontHistory", "POST", { member: record.member_id, custom: false, live: true, startTime: now, customStatus: desiredStatus }, token) as any;
				const front_id = data?._id || data?.id || null;
				return new Response(JSON.stringify({ success: true, result: "created_front_entry", front_id, member_id: record.member_id, name: record.name }), { headers: { "Content-Type": "application/json" } });
			} catch (e) {
				return new Response(JSON.stringify({ success: false, error: String(e) }), { status: 400, headers: { "Content-Type": "application/json" } });
			}
		}

		// Internal: add a note to a system member
		if (url.pathname === "/internal/add-member-note" && request.method === "POST") {
			try {
				const body = await request.json() as { member_id: string; note: string; title?: string; color?: string };
				const { record } = resolveMemberInput(body.member_id);
				const token = (env as any).SIMPLY_PLURAL_TOKEN;
				if (!token) return new Response(JSON.stringify({ success: false, error: "SIMPLY_PLURAL_TOKEN not set" }), { status: 500, headers: { "Content-Type": "application/json" } });

				const data = await spRequest("/note", "POST", {
					member: record.member_id,
					date: Date.now(),
					title: body.title || "MCP Note",
					color: body.color || "#808080",
					supportMarkdown: true,
					note: body.note,
				}, token) as any;
				const note_id = data?._id || data?.id || null;
				return new Response(JSON.stringify({ success: true, id: note_id, member_id: record.member_id, name: record.name }), { headers: { "Content-Type": "application/json" } });
			} catch (e) {
				return new Response(JSON.stringify({ success: false, error: String(e) }), { status: 400, headers: { "Content-Type": "application/json" } });
			}
		}

		return new Response("Not found", { status: 404 });
	}
};

const oauthProvider = new OAuthProvider({
	apiRoute: "/mcp",
	apiHandler: NullsafePluralMCP.serve("/mcp") as any,
	defaultHandler,
	authorizeEndpoint: "/authorize",
	tokenEndpoint: "/token",
	clientRegistrationEndpoint: "/register",
});

export default {
	fetch(request: Request, env: any, ctx: ExecutionContext) {
		return oauthProvider.fetch(request, env, ctx);
	}
}
