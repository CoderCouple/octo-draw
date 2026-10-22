/**
 * AgentAction[] as a strict JSON Schema (for the Claude `apply_actions` tool)
 * and as zod (runtime validation of model / MCP input). Keep both in sync with
 * packages/core/src/agent.ts.
 */

import { z } from 'zod'
import { NODE_SHAPES, type AgentAction } from '@octo-draw/core'

const DIRECTIONS = ['down', 'up', 'right', 'left'] as const
const OPS = ['>', '<', '<>', '-', '--', '-->'] as const

type JsonSchema = Record<string, unknown>

const str = (description?: string): JsonSchema => (description ? { type: 'string', description } : { type: 'string' })

function action(type: string, props: Record<string, JsonSchema>, required: string[], description: string): JsonSchema {
	return {
		type: 'object',
		description,
		properties: { type: { type: 'string', enum: [type] }, ...props },
		required: ['type', ...required],
		additionalProperties: false,
	}
}

const shape: JsonSchema = { type: 'string', enum: [...NODE_SHAPES] }

export const AGENT_ACTION_JSON_SCHEMA: JsonSchema = {
	anyOf: [
		action(
			'addNode',
			{
				key: str('Node name (identity), e.g. "API gateway"'),
				label: str('Display label if different from key'),
				shape,
				icon: str('Icon name, e.g. server, database, users, aws-lambda'),
				color: str('Palette name (blue, red, green, ...) or #hex'),
				parent: str('Key of an existing group to place the node in'),
			},
			['key'],
			'Declare a new node',
		),
		action(
			'updateNode',
			{ key: str(), label: str(), shape, icon: str(), color: str() },
			['key'],
			'Change properties of an existing node (only the given fields)',
		),
		action('removeNode', { key: str() }, ['key'], 'Delete a node and its edges'),
		action(
			'addEdge',
			{
				from: str(),
				to: str(),
				label: str(),
				op: { type: 'string', enum: [...OPS], description: '> arrow (default), < reverse, <> both, - line, -- dotted line, --> dotted arrow' },
				id: str('Optional explicit edge id'),
			},
			['from', 'to'],
			'Connect two nodes (missing nodes are created implicitly)',
		),
		action('removeEdge', { from: str(), to: str(), id: str() }, ['from', 'to'], 'Delete an edge'),
		action(
			'addGroup',
			{
				key: str(),
				label: str(),
				color: str(),
				icon: str(),
				children: { type: 'array', items: { type: 'string' }, description: 'Existing node keys to move into the group' },
			},
			['key'],
			'Create a group/container',
		),
		action('setDirection', { direction: { type: 'string', enum: [...DIRECTIONS] } }, ['direction'], 'Set layout direction'),
		action(
			'replaceCode',
			{ code: str('Full diagram source'), format: { type: 'string', enum: ['octo', 'mermaid'] } },
			['code'],
			'Replace the whole diagram (use only for large rewrites)',
		),
	],
}

export const APPLY_ACTIONS_INPUT_SCHEMA = {
	type: 'object' as const,
	properties: {
		actions: { type: 'array', items: AGENT_ACTION_JSON_SCHEMA, description: 'Edits to apply, in order' },
	},
	required: ['actions'],
	additionalProperties: false,
}

const zShape = z.enum(NODE_SHAPES as unknown as [string, ...string[]])
const o = z.string().optional()

export const AgentActionZ = z.discriminatedUnion('type', [
	z.object({ type: z.literal('addNode'), key: z.string(), label: o, shape: zShape.optional(), icon: o, color: o, parent: o }),
	z.object({ type: z.literal('updateNode'), key: z.string(), label: o, shape: zShape.optional(), icon: o, color: o }),
	z.object({ type: z.literal('removeNode'), key: z.string() }),
	z.object({ type: z.literal('addEdge'), from: z.string(), to: z.string(), label: o, op: z.enum(OPS).optional(), id: o }),
	z.object({ type: z.literal('removeEdge'), from: z.string(), to: z.string(), id: o }),
	z.object({ type: z.literal('addGroup'), key: z.string(), label: o, color: o, icon: o, children: z.array(z.string()).optional() }),
	z.object({ type: z.literal('setDirection'), direction: z.enum(DIRECTIONS) }),
	z.object({ type: z.literal('replaceCode'), code: z.string(), format: z.enum(['octo', 'mermaid']).optional() }),
])

export const AgentActionsZ = z.array(AgentActionZ)

export function parseActions(input: unknown): { ok: true; actions: AgentAction[] } | { ok: false; error: string } {
	const r = AgentActionsZ.safeParse(input)
	if (!r.success) return { ok: false, error: z.prettifyError(r.error) }
	return { ok: true, actions: r.data as AgentAction[] }
}
