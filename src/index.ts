import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import memberMap from "./members.json";

const SIMPLY_PLURAL_BASE = "https://api.apparyllis.com/v1";

type MemberEntry = { name: string; pk: string };
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
		throw new Error(`SimplyPlural error ${res.status} on ${path}: ${err}`);
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
				return {
					content: [{
						type: "text",
						text: JSON.stringify({
							member_id: record.member_id,
							name: record.name,
							matched_by
						}, null, 2)
					}]
				};
			} catch (err) {
				return { content: [{ type: "text", text: (err as Error).message }] };
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
			limit: z.number().optional().describe("Number of entries to return, default 20")
		}, async ({ limit }) => {
			const data = await spRequest(`/frontHistory?limit=${limit || 20}`, "GET", null, token) as any[];
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
			if (request.method === "GET") {
				const oauthReqInfo = await env.OAUTH_PROVIDER.parseAuthRequest(request);
				if (!oauthReqInfo.clientId) {
					return new Response("Invalid authorization request", { status: 400 });
				}

				return new Response(`<!DOCTYPE html>
<html>
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
    <input type="hidden" name="client_id" value="${oauthReqInfo.clientId}">
    <input type="hidden" name="redirect_uri" value="${oauthReqInfo.redirectUri}">
    <input type="hidden" name="state" value="${oauthReqInfo.state || ""}">
    <input type="hidden" name="scope" value="${(oauthReqInfo.scope || []).join(" ")}">
    <input type="hidden" name="code_challenge" value="${oauthReqInfo.codeChallenge || ""}">
    <input type="hidden" name="code_challenge_method" value="${oauthReqInfo.codeChallengeMethod || ""}">
    <button type="submit" name="action" value="approve" class="approve">Approve</button>
    <button type="submit" name="action" value="deny" class="deny">Deny</button>
  </form>
</body>
</html>`, { headers: { "Content-Type": "text/html" } });
			}

			if (request.method === "POST") {
				const body = await request.formData();
				const action = body.get("action");

				if (action === "deny") {
					return new Response("Access denied", { status: 403 });
				}

				const clientId = body.get("client_id") as string;
				const redirectUri = body.get("redirect_uri") as string;
				const state = body.get("state") as string;
				const scope = (body.get("scope") as string || "").split(" ").filter(Boolean);
				const codeChallenge = body.get("code_challenge") as string;
				const codeChallengeMethod = body.get("code_challenge_method") as string;

				const syntheticUrl = new URL(request.url);
				syntheticUrl.pathname = "/authorize";
				syntheticUrl.search = "";
				syntheticUrl.searchParams.set("response_type", "code");
				syntheticUrl.searchParams.set("client_id", clientId);
				syntheticUrl.searchParams.set("redirect_uri", redirectUri);
				syntheticUrl.searchParams.set("state", state);
				syntheticUrl.searchParams.set("scope", scope.join(" "));
				if (codeChallenge) syntheticUrl.searchParams.set("code_challenge", codeChallenge);
				if (codeChallengeMethod) syntheticUrl.searchParams.set("code_challenge_method", codeChallengeMethod);

				const syntheticRequest = new Request(syntheticUrl.toString(), { method: "GET" });
				const oauthReqInfo = await env.OAUTH_PROVIDER.parseAuthRequest(syntheticRequest);

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
