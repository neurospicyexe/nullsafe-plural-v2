import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";

const SIMPLY_PLURAL_BASE = "https://api.apparyllis.com/v1";

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
		throw new Error(`SimplyPlural error ${res.status}: ${err}`);
	}
	return res.json();
}

export class NullsafePluralMCP extends McpAgent {
	server = new McpServer({
		name: "Nullsafe Plural MCP",
		version: "1.0.0",
	});

	async init() {
		const token = (this.env as any).SIMPLY_PLURAL_TOKEN;

		this.server.tool(
			"get_current_front",
			{},
			async () => {
				const data = await spRequest("/fronters", "GET", null, token);
				return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
			}
		);

		this.server.tool(
			"log_front_change",
			{
				member_id: z.string().describe("SimplyPlural member ID"),
				status: z.enum(["fronting", "co-con", "unknown"]).describe("Front status type"),
				custom_status: z.string().optional().describe("Optional custom status note")
			},
			async ({ member_id, status, custom_status }) => {
				const payload = {
					member: member_id,
					customStatus: custom_status || status,
					live: true
				};
				const data = await spRequest("/fronters", "POST", payload, token);
				return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
			}
		);

		this.server.tool(
			"get_member",
			{
				member_id: z.string().describe("SimplyPlural member ID")
			},
			async ({ member_id }) => {
				const data = await spRequest(`/member/${member_id}`, "GET", null, token);
				return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
			}
		);

		this.server.tool(
			"add_member_note",
			{
				member_id: z.string().describe("SimplyPlural member ID"),
				note: z.string().describe("Note to add to member profile")
			},
			async ({ member_id, note }) => {
				const payload = { note };
				const data = await spRequest(`/member/${member_id}`, "PATCH", payload, token);
				return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
			}
		);

		this.server.tool(
			"get_front_history",
			{
				limit: z.number().optional().describe("Number of entries to return, default 20")
			},
			async ({ limit }) => {
				const data = await spRequest(`/frontHistory?limit=${limit || 20}`, "GET", null, token);
				return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
			}
		);

		this.server.tool(
			"search_members",
			{
				name: z.string().describe("Name or partial name to search for")
			},
			async ({ name }) => {
				const data = await spRequest("/members", "GET", null, token) as any;
				const members = Array.isArray(data) ? data : data.members || [];
				const matches = members.filter((m: any) =>
					m.name && m.name.toLowerCase().includes(name.toLowerCase())
				);
				return { content: [{ type: "text", text: JSON.stringify(matches, null, 2) }] };
			}
		);
	}
}

export default {
	fetch(request: Request, env: Env, ctx: ExecutionContext) {
		const url = new URL(request.url);
		if (url.pathname === "/mcp") {
			return NullsafePluralMCP.serve("/mcp").fetch(request, env, ctx);
		}
		return new Response("Not found", { status: 404 });
	},
};
