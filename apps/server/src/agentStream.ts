/**
 * The streaming chat agent behind POST /api/agent/stream: multi-turn history
 * from the client, the apply_actions tool loop, text deltas as they arrive and
 * one `actions` event per validated tool call. An `explain` mode answers
 * without tools.
 */

import { applyActions, type AgentAction } from '@octo-draw/core'
import { APPLY_ACTIONS_TOOL, diagnosticsText } from './ai'
import { echoContent, RefusalError, textOf, type MessageParam, type StreamFn, type ToolResult } from './claude'
import { AGENT_CHAT_SYSTEM, agentChatUserMessage, EXPLAIN_SYSTEM } from './prompts'
import { parseActions } from './schema'

export type AgentMode = 'auto' | 'edit' | 'explain'

export interface ChatTurn {
	role: 'user' | 'assistant'
	content: string
}

export interface AgentStreamInput {
	prompt: string
	code: string
	history?: ChatTurn[]
	selection?: string[]
	mode?: AgentMode
	signal?: AbortSignal
}

export type AgentStreamEvent =
	| { type: 'mode'; mode: AgentMode }
	| { type: 'text'; delta: string }
	/** Number of actions in the tool call currently being streamed (tolerant parse; the last one may be partial). */
	| { type: 'progress'; count: number }
	| { type: 'actions'; actions: AgentAction[]; code: string; applied: number; errors: string[] }
	| { type: 'done'; code: string; message: string; errors: string[] }
	| { type: 'error'; message: string }

export const AGENT_STREAM_MAX_TURNS = 5
const HISTORY_TURNS = 16
const HISTORY_CHARS = 6000

const EXPLAIN_RE = /^\s*(explain|describe|summari[sz]e|walk me through|tell me about|what('s| is| are| does| do)\b|why\b|how (does|do|is|are)\b)/i
const EDIT_RE =
	/^\s*(please\s+)?(add|remove|delete|drop|connect|link|make|change|rename|move|group|ungroup|insert|replace|put|split|merge|turn|convert|set|draw|create|use|swap|color|colour|label|reverse|flip|place|wrap|extract|introduce|attach|include)\b/i

/** Picks a mode from the wording when the client did not choose one. */
export function detectMode(prompt: string): AgentMode {
	if (EXPLAIN_RE.test(prompt)) return 'explain'
	if (EDIT_RE.test(prompt)) return 'edit'
	return 'auto'
}

/** Cleans client-supplied history into a valid alternating message list that starts with a user turn. */
export function historyMessages(history: unknown): MessageParam[] {
	if (!Array.isArray(history)) return []
	const out: { role: 'user' | 'assistant'; content: string }[] = []
	for (const t of history.slice(-HISTORY_TURNS)) {
		if (!t || typeof t !== 'object') continue
		const { role, content } = t as Record<string, unknown>
		if ((role !== 'user' && role !== 'assistant') || typeof content !== 'string' || !content.trim()) continue
		const text = content.length > HISTORY_CHARS ? `${content.slice(0, HISTORY_CHARS)}…` : content
		const prev = out[out.length - 1]
		if (prev && prev.role === role) prev.content += `\n\n${text}`
		else out.push({ role, content: text })
	}
	while (out[0]?.role === 'assistant') out.shift()
	return out
}

function lastMessages(history: MessageParam[], userText: string): MessageParam[] {
	const messages = [...history]
	const last = messages[messages.length - 1]
	if (last?.role === 'user') {
		messages[messages.length - 1] = { role: 'user', content: `${String(last.content)}\n\n${userText}` }
	} else messages.push({ role: 'user', content: userText })
	return messages
}

export async function runAgentStream(
	stream: StreamFn,
	input: AgentStreamInput,
	emit: (e: AgentStreamEvent) => void,
	onCode?: (code: string) => void,
): Promise<{ code: string; actions: AgentAction[]; message: string; errors: string[] }> {
	const mode = input.mode ?? detectMode(input.prompt)
	emit({ type: 'mode', mode })
	let code = input.code
	const actions: AgentAction[] = []
	let errors: string[] = []
	let message = ''
	const onText = (delta: string) => {
		message += delta
		emit({ type: 'text', delta })
	}
	const messages = lastMessages(historyMessages(input.history), agentChatUserMessage(input.prompt, code, input.selection ?? []))

	if (mode === 'explain') {
		const res = await stream({ system: EXPLAIN_SYSTEM, messages, effort: 'low', signal: input.signal }, onText)
		if (res.stop_reason === 'refusal') throw new RefusalError(res)
		message = textOf(res)
		emit({ type: 'done', code, message: message.trim(), errors: [] })
		return { code, actions, message: message.trim(), errors }
	}

	let toolCalls = 0
	let progress = -1
	const onToolInput = (snapshot: unknown) => {
		const list = (snapshot as { actions?: unknown } | null)?.actions
		const n = Array.isArray(list) ? list.length : 0
		if (n !== progress) {
			progress = n
			emit({ type: 'progress', count: n })
		}
	}

	for (let turn = 0; turn < AGENT_STREAM_MAX_TURNS; turn++) {
		if (input.signal?.aborted) break
		if (turn > 0 && message && !message.endsWith('\n')) onText('\n\n')
		progress = -1
		const res = await stream(
			{ system: AGENT_CHAT_SYSTEM, messages, tools: [APPLY_ACTIONS_TOOL], effort: 'medium', signal: input.signal, onToolInput },
			onText,
		)
		// A refusal can cut a tool_use off mid-input: never run that turn's tools.
		if (res.stop_reason === 'refusal') {
			if (toolCalls === 0) throw new RefusalError(res)
			break
		}
		const content = echoContent(res.content)
		const uses = content.filter((b) => b.type === 'tool_use')
		// A truncated tool input usually still parses: do not apply it.
		if (res.stop_reason === 'max_tokens' && uses.length > 0) {
			errors.push('Model output was truncated; the last tool call was not applied')
			break
		}
		if (uses.length === 0) {
			// tool_choice auto does not guarantee a call: nudge once for clear edit requests.
			if (mode === 'edit' && toolCalls === 0 && turn === 0) {
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
			// Eager input streaming: the API did not validate this input, so validate before applying.
			const parsed = parseActions((use.input as { actions?: unknown } | null)?.actions)
			if (!parsed.ok) {
				results.push({
					type: 'tool_result',
					tool_use_id: use.id,
					is_error: true,
					content: JSON.stringify({ INVALID_INPUT: parsed.error }),
				})
				continue
			}
			const result = applyActions(code, parsed.actions)
			code = result.code
			actions.push(...parsed.actions)
			errors = result.errors.map((e) => `action ${e.index} (${parsed.actions[e.index]?.type ?? '?'}): ${e.message}`)
			onCode?.(code)
			emit({ type: 'actions', actions: parsed.actions, code, applied: result.applied, errors })
			const diagnostics = diagnosticsText(code)
			results.push({
				type: 'tool_result',
				tool_use_id: use.id,
				is_error: errors.length > 0 || undefined,
				content: JSON.stringify({ applied: result.applied, errors, diagnostics: diagnostics || undefined, code }),
			})
		}
		messages.push({ role: 'user', content: results })
		if (res.stop_reason !== 'tool_use') break
	}

	const parseErrors = diagnosticsText(code)
	const allErrors = parseErrors ? [...errors, parseErrors] : errors
	emit({ type: 'done', code, message: message.trim(), errors: allErrors })
	return { code, actions, message: message.trim(), errors: allErrors }
}
