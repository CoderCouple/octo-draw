/**
 * MCP stdio server for octo-draw. Proxies to the running HTTP server's
 * document (`/api/doc*`), so edits show up live in the web app.
 *
 *   claude mcp add octo-draw -- pnpm --silent --dir <repo>/apps/server mcp
 *
 * stdout is the MCP channel: log only to stderr.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { importText, parseOcto, printOcto, toMermaid } from '@octo-draw/core'
import { AgentActionZ } from './schema'
import { DSL_REFERENCE } from './prompts'
import { describeDiagram } from './describe'

const BASE = (process.env.OCTO_SERVER_URL ?? 'http://localhost:8787').replace(/\/+$/, '')
const SOURCE = 'mcp'

interface DocResponse {
	code: string
	version: number
	applied?: number
	errors?: { index: number; message: string }[]
	error?: string
}

async function call(method: string, path: string, body?: unknown): Promise<DocResponse> {
	let res: Response
	try {
		res = await fetch(`${BASE}${path}`, {
			method,
			headers: body ? { 'Content-Type': 'application/json' } : undefined,
			body: body ? JSON.stringify(body) : undefined,
		})
	} catch {
		throw new Error(`octo-draw server is not reachable at ${BASE}. Start it with: pnpm --dir apps/server dev`)
	}
	const data = (await res.json().catch(() => ({}))) as DocResponse
	if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
	return data
}

const DOC_ID = z
	.string()
	.regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/)
	.optional()
	.describe('Document (room) id. Omit for the default document open in the editor.')

/** Appends `?docId=` when a document id is given. */
const withDoc = (path: string, docId?: string) => (docId ? `${path}${path.includes('?') ? '&' : '?'}docId=${encodeURIComponent(docId)}` : path)

const text = (t: string): CallToolResult => ({ content: [{ type: 'text', text: t }] })
const fail = (t: string): CallToolResult => ({ content: [{ type: 'text', text: t }], isError: true })

function diagnostics(code: string): string {
	const errs = parseOcto(code).diagnostics.filter((d) => d.severity === 'error')
	return errs.length ? `\n\nParse errors:\n${errs.map((d) => `- ${d.message} (offset ${d.from})`).join('\n')}` : ''
}

async function guard(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
	try {
		return await fn()
	} catch (err) {
		return fail(err instanceof Error ? err.message : String(err))
	}
}

const server = new McpServer(
	{ name: 'octo-draw', version: '0.0.1' },
	{
		instructions:
			'octo-draw is a diagram-as-code editor. The diagram is octo DSL text (Eraser-compatible). ' +
			'Read it with get_diagram, edit with apply_actions (preferred, targeted) or set_diagram (full rewrite). ' +
			'Edits appear live in the user\'s open octo-draw editor.',
	},
)

server.registerTool(
	'get_diagram',
	{
		title: 'Get diagram',
		description: 'Return the current diagram source (octo DSL) and its version.',
		inputSchema: { docId: DOC_ID },
		annotations: { readOnlyHint: true },
	},
	({ docId }) => guard(async () => {
		const doc = await call('GET', withDoc('/api/doc', docId))
		return text(`version: ${doc.version}\n\n${doc.code || '(empty diagram)'}`)
	}),
)

server.registerTool(
	'set_diagram',
	{
		title: 'Set diagram',
		description: `Replace the whole diagram with new octo DSL code.\n\n${DSL_REFERENCE}`,
		inputSchema: {
			code: z.string().describe('Full octo DSL source'),
			baseVersion: z.number().int().optional().describe('If given, fail when the diagram changed since this version'),
			docId: DOC_ID,
		},
	},
	({ code, baseVersion, docId }) => guard(async () => {
		const doc = await call('PUT', withDoc('/api/doc', docId), { code, baseVersion, source: SOURCE })
		return text(`Diagram updated (version ${doc.version}).${diagnostics(doc.code)}`)
	}),
)

server.registerTool(
	'apply_actions',
	{
		title: 'Apply actions',
		description:
			'Apply targeted edits to the diagram. Nodes are addressed by key (their DSL name). ' +
			'addEdge op: ">" arrow, "<" reverse, "<>" both, "-" line, "--" dotted line, "-->" dotted arrow. ' +
			'Returns the resulting code and any per-action errors.',
		inputSchema: { actions: z.array(AgentActionZ).describe('Edits, applied in order'), docId: DOC_ID },
	},
	({ actions, docId }) => guard(async () => {
		const doc = await call('POST', withDoc('/api/doc/actions', docId), { actions, source: SOURCE })
		const errs = doc.errors?.length ? `\n\nErrors:\n${doc.errors.map((e) => `- action ${e.index}: ${e.message}`).join('\n')}` : ''
		return text(`Applied ${doc.applied ?? 0}/${actions.length} actions (version ${doc.version}).${errs}${diagnostics(doc.code)}\n\n${doc.code}`)
	}),
)

server.registerTool(
	'import_text',
	{
		title: 'Import text diagram',
		description:
			'Convert a diagram given as text (mermaid flowchart, ASCII/Unicode box art from a chat answer, or octo DSL; markdown fences allowed) ' +
			'into octo DSL and make it the current diagram.',
		inputSchema: { text: z.string().describe('The diagram text'), docId: DOC_ID },
	},
	({ text: input, docId }) => guard(async () => {
		const r = importText(input)
		if (!r) return fail('Could not recognise a diagram in that text.')
		const code = printOcto(r.ir)
		const doc = await call('PUT', withDoc('/api/doc', docId), { code, source: SOURCE })
		const warn = r.diagnostics.length ? `\n\nImport diagnostics:\n${r.diagnostics.map((d) => `- ${d.message}`).join('\n')}` : ''
		return text(`Imported ${r.format} (${r.ir.nodes.length} nodes, ${r.ir.edges.length} edges) as version ${doc.version}.${warn}\n\n${code}`)
	}),
)

server.registerTool(
	'export_mermaid',
	{
		title: 'Export mermaid',
		description: 'Return the current diagram as mermaid flowchart code.',
		inputSchema: { docId: DOC_ID },
		annotations: { readOnlyHint: true },
	},
	({ docId }) => guard(async () => {
		const doc = await call('GET', withDoc('/api/doc', docId))
		return text(toMermaid(parseOcto(doc.code).ir))
	}),
)

server.registerTool(
	'describe_diagram',
	{
		title: 'Describe diagram',
		description:
			'Return the current diagram as structured JSON: a one-line summary, stats (node/group/edge counts, entry points, sinks, ' +
			'most connected nodes, unconnected nodes, nesting depth, parse errors) and the full IR (nodes with key/label/shape/icon/parent, ' +
			'edges with from/to/label/arrows). Use it to reason about structure before editing; use get_diagram for the source text.',
		inputSchema: { docId: DOC_ID },
		annotations: { readOnlyHint: true },
	},
	({ docId }) => guard(async () => {
		const doc = await call('GET', withDoc('/api/doc', docId))
		const { ir, stats, summary } = describeDiagram(doc.code)
		return text(JSON.stringify({ version: doc.version, summary, stats, ir }, null, 2))
	}),
)

server.registerTool(
	'get_diagram_svg',
	{
		title: 'Get diagram SVG',
		description: 'Render the current diagram to a standalone SVG (headless, laid out like the canvas). Useful to look at the result or save a thumbnail.',
		inputSchema: { theme: z.enum(['light', 'dark']).optional().describe('Color theme (default light)'), docId: DOC_ID },
		annotations: { readOnlyHint: true },
	},
	({ theme, docId }) => guard(async () => {
		let res: Response
		try {
			res = await fetch(`${BASE}${withDoc(`/api/doc/svg?theme=${theme ?? 'light'}`, docId)}`)
		} catch {
			throw new Error(`octo-draw server is not reachable at ${BASE}. Start it with: pnpm --dir apps/server dev`)
		}
		if (!res.ok) throw new Error(`HTTP ${res.status}`)
		return text(await res.text())
	}),
)

await server.connect(new StdioServerTransport())
console.error(`[octo-draw mcp] connected; proxying to ${BASE}`)
