/** AI features on top of a StreamFn: generate (streaming), vision import, and the tool-use agent. */

import { applyActions, parseOcto, type AgentAction } from '@octo-draw/core'
import { echoContent, RefusalError, textOf, type Message, type MessageParam, type StreamFn, type Tool, type ToolResult } from './claude'
import {
	AGENT_SYSTEM,
	agentUserMessage,
	GENERATE_SYSTEM,
	generateUserMessage,
	repairPrompt,
	VISION_SYSTEM,
	VISION_USER,
} from './prompts'
import { APPLY_ACTIONS_INPUT_SCHEMA, parseActions } from './schema'
import { FenceFilter, stripFences } from './text'

export function assertNotRefused(message: Message) {
	if (message.stop_reason === 'refusal') throw new RefusalError(message)
}

/** Parse errors formatted for the model, or '' when the code parses cleanly. */
export function diagnosticsText(code: string): string {
	const { diagnostics } = parseOcto(code)
	const errors = diagnostics.filter((d) => d.severity === 'error')
	if (errors.length === 0) return ''
	return errors
		.map((d) => {
			const line = code.slice(0, d.from).split('\n').length
			const text = code.split('\n')[line - 1] ?? ''
			return `- line ${line}: ${d.message}  (\`${text.trim()}\`)`
		})
		.join('\n')
}

export async function generate(
	stream: StreamFn,
	input: { prompt: string; code?: string },
	onDelta: (delta: string) => void,
): Promise<string> {
	const filter = new FenceFilter()
	const message = await stream(
		{
			system: GENERATE_SYSTEM,
			messages: [{ role: 'user', content: generateUserMessage(input.prompt, input.code) }],
			effort: 'medium',
		},
		(delta) => {
			const out = filter.push(delta)
			if (out) onDelta(out)
		},
	)
	const rest = filter.flush()
	if (rest) onDelta(rest)
	assertNotRefused(message)
	return stripFences(textOf(message))
}

export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'
export const IMAGE_MEDIA_TYPES: ImageMediaType[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']

export async function vision(
	stream: StreamFn,
	input: { imageBase64: string; mediaType: ImageMediaType },
): Promise<{ code: string; diagnostics: string }> {
	const data = input.imageBase64.replace(/^data:[^;]+;base64,/, '')
	const messages: MessageParam[] = [
		{
			role: 'user',
			content: [
				{ type: 'image', source: { type: 'base64', media_type: input.mediaType, data } },
				{ type: 'text', text: VISION_USER },
			],
		},
	]
	const first = await stream({ system: VISION_SYSTEM, messages, effort: 'medium' })
	assertNotRefused(first)
	let code = stripFences(textOf(first))
	let diagnostics = diagnosticsText(code)
	if (diagnostics) {
		// One repair round-trip with the parser's diagnostics.
		messages.push({ role: 'assistant', content: echoContent(first.content) })
		messages.push({ role: 'user', content: repairPrompt(diagnostics) })
		const second = await stream({ system: VISION_SYSTEM, messages, effort: 'medium' })
		if (second.stop_reason !== 'refusal') {
			const repaired = stripFences(textOf(second))
			if (repaired) {
				code = repaired
				diagnostics = diagnosticsText(code)
			}
		}
	}
	return { code, diagnostics }
}

export const APPLY_ACTIONS_TOOL: Tool = {
	name: 'apply_actions',
	description:
		'Apply a list of edits to the current octo diagram. Actions run in order against the diagram source. ' +
		'Returns the resulting code, the number of actions applied, per-action errors and parse diagnostics.',
	input_schema: APPLY_ACTIONS_INPUT_SCHEMA,
	strict: true,
	// Requests are always streamed: stream the input as generated. The server no
	// longer validates it, so every caller validates with `parseActions` (zod) before applying.
	eager_input_streaming: true,
}

export const AGENT_MAX_TURNS = 4

export interface AgentResult {
	actions: AgentAction[]
	code: string
	errors: string[]
	message: string
}

export async function runAgent(stream: StreamFn, input: { prompt: string; code: string }): Promise<AgentResult> {
	let code = input.code
	const actions: AgentAction[] = []
	let errors: string[] = []
	let finalText = ''
	let toolCalls = 0
	const messages: MessageParam[] = [{ role: 'user', content: agentUserMessage(input.prompt, code) }]

	for (let turn = 0; turn < AGENT_MAX_TURNS; turn++) {
		const message = await stream({ system: AGENT_SYSTEM, messages, tools: [APPLY_ACTIONS_TOOL], effort: 'medium' })
		if (message.stop_reason === 'refusal') {
			if (toolCalls === 0) throw new RefusalError(message)
			break
		}
		const content = echoContent(message.content)
		finalText = textOf(message)
		const uses = content.filter((b) => b.type === 'tool_use')
		if (message.stop_reason === 'max_tokens' && uses.length > 0) {
			errors.push('Model output was truncated; tool call not applied')
			break
		}
		if (uses.length === 0) {
			// tool_choice auto does not guarantee a call: nudge once if nothing was done yet.
			if (toolCalls === 0 && turn === 0) {
				messages.push({ role: 'assistant', content })
				messages.push({ role: 'user', content: 'Please make the change by calling the apply_actions tool.' })
				continue
			}
			break
		}

		messages.push({ role: 'assistant', content })
		const results: ToolResult[] = []
		for (const use of uses) {
			if (use.type !== 'tool_use') continue
			toolCalls++
			if (use.name !== APPLY_ACTIONS_TOOL.name) {
				results.push({ type: 'tool_result', tool_use_id: use.id, is_error: true, content: `Unknown tool ${use.name}` })
				continue
			}
			const parsed = parseActions((use.input as { actions?: unknown })?.actions)
			if (!parsed.ok) {
				results.push({ type: 'tool_result', tool_use_id: use.id, is_error: true, content: `Invalid actions: ${parsed.error}` })
				continue
			}
			const result = applyActions(code, parsed.actions)
			code = result.code
			actions.push(...parsed.actions)
			errors = result.errors.map((e) => `action ${e.index} (${parsed.actions[e.index]?.type ?? '?'}): ${e.message}`)
			const diagnostics = diagnosticsText(code)
			results.push({
				type: 'tool_result',
				tool_use_id: use.id,
				is_error: errors.length > 0 || undefined,
				content: JSON.stringify({ applied: result.applied, errors, diagnostics: diagnostics || undefined, code }),
			})
		}
		messages.push({ role: 'user', content: results })
		if (message.stop_reason !== 'tool_use') break
	}

	const parseErrors = diagnosticsText(code)
	return { actions, code, errors: parseErrors ? [...errors, parseErrors] : errors, message: finalText.trim() }
}
