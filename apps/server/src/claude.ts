/**
 * The only module that talks to the Anthropic SDK. Everything else uses the
 * `StreamFn` abstraction so tests can inject a fake.
 */

import Anthropic from '@anthropic-ai/sdk'
import { loadConfig } from '@anthropic-ai/sdk/lib/credentials'

export const MODEL = 'claude-opus-5-5'
export const MAX_TOKENS = 32000

export type Message = Anthropic.Beta.BetaMessage
export type MessageParam = Anthropic.Beta.BetaMessageParam
export type ContentBlock = Anthropic.Beta.BetaContentBlock
export type Tool = Anthropic.Beta.BetaTool
export type ToolResult = Anthropic.Beta.BetaToolResultBlockParam

export interface StreamRequest {
	system: string
	messages: MessageParam[]
	tools?: Tool[]
	effort?: 'low' | 'medium' | 'high'
	/** Aborts the model request (client disconnected / user pressed stop). */
	signal?: AbortSignal
	/** Receives the tolerant-parsed snapshot of the tool input currently streaming (eager input streaming). */
	onToolInput?: (snapshot: unknown) => void
	/** Structured outputs: constrain the text reply to this JSON schema (`output_config.format`). */
	outputFormat?: { type: 'json_schema'; schema: Record<string, unknown> }
}

/** Runs one streamed model turn; `onText` receives text deltas. Resolves with the final message. */
export type StreamFn = (req: StreamRequest, onText?: (delta: string) => void) => Promise<Message>

export const NO_CREDENTIALS = 'No Anthropic credentials. Set ANTHROPIC_API_KEY or run ant auth login'

export async function hasCredentials(): Promise<boolean> {
	if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) return true
	try {
		return (await loadConfig()) !== null
	} catch {
		return false
	}
}

// ---------------------------------------------------------------------------
// Server-side refusal fallbacks (beta). Isolated here so it can be removed:
// delete this block and make `withFallbacks` / `echoContent` identities.
// Disable at runtime with OCTO_FALLBACKS=0.

const FALLBACKS_ENABLED = process.env.OCTO_FALLBACKS !== '0'
const FALLBACK_BETA = 'server-side-fallback-2026-07-01'

export const fallbacksEnabled = () => FALLBACKS_ENABLED

function withFallbacks<T extends object>(params: T): T & { betas?: string[]; fallbacks?: 'default' } {
	if (!FALLBACKS_ENABLED) return params
	return { ...params, betas: [FALLBACK_BETA], fallbacks: 'default' as const }
}

/**
 * Content to echo back as the assistant turn. After a mid-output fallback,
 * model-internal blocks (thinking, tool_use, ...) before the last `fallback`
 * block must be dropped; text and everything after the boundary is kept.
 */
export function echoContent(content: ContentBlock[]): ContentBlock[] {
	let last = -1
	content.forEach((b, i) => {
		if ((b as { type: string }).type === 'fallback') last = i
	})
	if (last === -1) return content
	return content.filter((b, i) => i >= last || b.type === 'text')
}
// ---------------------------------------------------------------------------

/** Consecutive re-issues allowed when a streamed tool input is not parseable JSON. */
const JSON_RETRIES = 2

export function createStreamFn(client: Anthropic = new Anthropic()): StreamFn {
	return async (req, onText) => {
		for (let attempt = 0; ; attempt++) {
			const stream = client.beta.messages.stream(
				withFallbacks({
					model: MODEL,
					max_tokens: MAX_TOKENS,
					system: req.system,
					messages: req.messages,
					...(req.tools ? { tools: req.tools, tool_choice: { type: 'auto' as const } } : {}),
					output_config: { effort: req.effort ?? 'medium', ...(req.outputFormat ? { format: req.outputFormat } : {}) },
				}),
				req.signal ? { signal: req.signal } : undefined,
			)
			if (onText) stream.on('text', (delta) => onText(delta))
			if (req.onToolInput) stream.on('inputJson', (_delta, snapshot) => req.onToolInput!(snapshot))
			try {
				return await stream.finalMessage()
			} catch (err) {
				// With eager input streaming the SDK rejects when a tool input is not
				// parseable at all. Only that case is re-issued; API errors and aborts are rethrown.
				if (err instanceof Anthropic.APIError || req.signal?.aborted || attempt >= JSON_RETRIES) throw err
				console.warn('[octo-draw] tool input was not parseable JSON, re-issuing the turn')
			}
		}
	}
}

export function textOf(message: Message): string {
	return message.content
		.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
		.map((b) => b.text)
		.join('')
}

export class RefusalError extends Error {
	constructor(message: Message) {
		const d = message.stop_details as { explanation?: string | null } | null | undefined
		super(`The model declined this request${d?.explanation ? `: ${d.explanation}` : ''}`)
	}
}

export function errorMessage(err: unknown): { status: number; message: string } {
	if (err instanceof RefusalError) return { status: 422, message: err.message }
	if (err instanceof Anthropic.AuthenticationError) return { status: 503, message: NO_CREDENTIALS }
	if (err instanceof Anthropic.RateLimitError) return { status: 429, message: 'Rate limited by Anthropic API, retry later' }
	if (err instanceof Anthropic.APIError) return { status: 502, message: `Anthropic API error ${err.status ?? ''}: ${err.message}` }
	return { status: 500, message: err instanceof Error ? err.message : String(err) }
}
