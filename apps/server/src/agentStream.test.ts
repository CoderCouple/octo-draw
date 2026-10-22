import { describe, expect, it } from 'vitest'
import { detectMode, historyMessages, runAgentStream, type AgentStreamEvent } from './agentStream'
import type { Message, StreamFn, StreamRequest } from './claude'

function msg(content: unknown[], stop_reason = 'end_turn'): Message {
	return { content, stop_reason } as unknown as Message
}

/** A fake model: each call pops the next scripted turn and streams its text. */
function fakeModel(turns: ((req: StreamRequest) => Message)[]) {
	const requests: StreamRequest[] = []
	const stream: StreamFn = async (req, onText) => {
		requests.push({ ...req, messages: [...req.messages] })
		const next = turns.shift()
		if (!next) throw new Error('unexpected model call')
		const m = next(req)
		for (const b of m.content) if (b.type === 'text') onText?.(b.text)
		return m
	}
	return { stream, requests }
}

const toolUse = (id: string, actions: unknown, extra: unknown[] = []) => () =>
	msg([...extra, { type: 'tool_use', id, name: 'apply_actions', input: { actions } }], 'tool_use')

async function collect(stream: StreamFn, input: Parameters<typeof runAgentStream>[1]) {
	const events: AgentStreamEvent[] = []
	const codes: string[] = []
	const result = await runAgentStream(stream, input, (e) => events.push(e), (c) => codes.push(c))
	return { events, codes, result }
}

describe('detectMode', () => {
	it('classifies requests', () => {
		expect(detectMode('explain this diagram')).toBe('explain')
		expect(detectMode('What does the worker do?')).toBe('explain')
		expect(detectMode('add a cache between API and DB')).toBe('edit')
		expect(detectMode('make it left to right')).toBe('edit')
		expect(detectMode('it feels cluttered')).toBe('auto')
	})
})

describe('historyMessages', () => {
	it('drops junk, merges same-role turns and starts with user', () => {
		expect(
			historyMessages([
				{ role: 'assistant', content: 'hi' },
				{ role: 'user', content: 'a' },
				{ role: 'user', content: 'b' },
				{ role: 'system', content: 'x' },
				{ role: 'assistant', content: '' },
				{ role: 'assistant', content: 'ok' },
				42,
			]),
		).toEqual([
			{ role: 'user', content: 'a\n\nb' },
			{ role: 'assistant', content: 'ok' },
		])
		expect(historyMessages('nope')).toEqual([])
	})
})

describe('runAgentStream', () => {
	it('streams text, emits actions per tool call and writes each step', async () => {
		const { stream, requests } = fakeModel([
			toolUse('t1', [{ type: 'addNode', key: 'Cache', icon: 'database' }, { type: 'removeEdge', from: 'API', to: 'DB' }], [
				{ type: 'text', text: 'Adding a cache.' },
			]),
			toolUse('t2', [{ type: 'addEdge', from: 'API', to: 'Cache' }, { type: 'addEdge', from: 'Cache', to: 'DB' }]),
			(req) => {
				const last = req.messages.at(-1)!
				expect(Array.isArray(last.content) && last.content[0].type).toBe('tool_result')
				return msg([{ type: 'text', text: 'Put Cache between API and DB.' }])
			},
		])
		const { events, codes, result } = await collect(stream, {
			prompt: 'add a cache between API and DB',
			code: 'API > DB\n',
			selection: ['API'],
			history: [
				{ role: 'user', content: 'draw an API and a DB' },
				{ role: 'assistant', content: 'Done.' },
			],
		})
		expect(events[0]).toEqual({ type: 'mode', mode: 'edit' })
		const acts = events.filter((e) => e.type === 'actions')
		expect(acts).toHaveLength(2)
		expect(codes).toHaveLength(2)
		expect(result.code).toMatch(/Cache/)
		expect(result.code).toMatch(/API > Cache/)
		expect(result.code).not.toMatch(/API > DB/)
		expect(result.actions).toHaveLength(4)
		expect(events.at(-1)).toMatchObject({ type: 'done', errors: [] })
		const text = events.flatMap((e) => (e.type === 'text' ? [e.delta] : [])).join('')
		expect(text).toBe('Adding a cache.\n\nPut Cache between API and DB.')
		// history + current turn, with selection context and tool marked for eager streaming
		expect(requests[0].messages).toHaveLength(3)
		expect(String(requests[0].messages[2].content)).toContain('Selected nodes: "API"')
		expect(requests[0].tools?.[0]).toMatchObject({ name: 'apply_actions', eager_input_streaming: true })
	})

	it('rejects invalid tool input without applying and lets the model retry', async () => {
		const { stream, requests } = fakeModel([
			toolUse('t1', [{ type: 'teleport', key: 'X' }]),
			toolUse('t2', [{ type: 'setDirection', direction: 'right' }]),
			() => msg([{ type: 'text', text: 'Now left to right.' }]),
		])
		const { events, result } = await collect(stream, { prompt: 'make it left to right', code: 'A > B\n' })
		const second = requests[1].messages.at(-1)!.content as { is_error?: boolean; content: string }[]
		expect(second[0].is_error).toBe(true)
		expect(second[0].content).toContain('INVALID_INPUT')
		expect(events.filter((e) => e.type === 'actions')).toHaveLength(1)
		expect(result.code).toMatch(/direction right/)
	})

	it('does not apply tool calls cut off by max_tokens or refusal', async () => {
		const trunc = fakeModel([() => msg([{ type: 'tool_use', id: 't', name: 'apply_actions', input: { actions: [{ type: 'addEdge', from: 'A', to: 'C' }] } }], 'max_tokens')])
		const r1 = await collect(trunc.stream, { prompt: 'connect A to C', code: 'A > B\n' })
		expect(r1.codes).toEqual([])
		expect(r1.result.errors[0]).toMatch(/truncated/)

		const refused = fakeModel([() => msg([{ type: 'tool_use', id: 't', name: 'apply_actions', input: { actions: [] } }], 'refusal')])
		await expect(collect(refused.stream, { prompt: 'add X', code: '' })).rejects.toThrow(/declined/)
	})

	it('nudges once when an edit request gets no tool call', async () => {
		const { stream, requests } = fakeModel([
			() => msg([{ type: 'text', text: 'Sure.' }]),
			toolUse('t1', [{ type: 'addEdge', from: 'A', to: 'C' }]),
			() => msg([{ type: 'text', text: 'Connected.' }]),
		])
		const { result } = await collect(stream, { prompt: 'connect A to C', code: 'A > B\n' })
		expect(String(requests[1].messages.at(-1)!.content)).toMatch(/apply_actions/)
		expect(result.code).toMatch(/A > C/)
	})

	it('explain mode answers without tools and leaves the code alone', async () => {
		const { stream, requests } = fakeModel([() => msg([{ type: 'text', text: 'Users call the API, which reads the DB.' }])])
		const { events, codes, result } = await collect(stream, { prompt: 'explain this diagram', code: 'Users > API > DB\n' })
		expect(requests[0].tools).toBeUndefined()
		expect(codes).toEqual([])
		expect(result.code).toBe('Users > API > DB\n')
		expect(events.at(-1)).toMatchObject({ type: 'done', message: 'Users call the API, which reads the DB.' })
	})

	it('reports streaming tool-input progress', async () => {
		const stream: StreamFn = async (req) => {
			if (req.messages.length > 1) return msg([{ type: 'text', text: 'ok' }])
			req.onToolInput?.({ actions: [{}] })
			req.onToolInput?.({ actions: [{}] })
			req.onToolInput?.({ actions: [{}, {}] })
			return msg([{ type: 'tool_use', id: 't', name: 'apply_actions', input: { actions: [{ type: 'addEdge', from: 'A', to: 'B' }] } }], 'tool_use')
		}
		const { events } = await collect(stream, { prompt: 'connect A and B', code: '' })
		expect(events.filter((e) => e.type === 'progress')).toEqual([
			{ type: 'progress', count: 1 },
			{ type: 'progress', count: 2 },
		])
	})
})
