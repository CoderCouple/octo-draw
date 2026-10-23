import { layoutDiagram, parseOctoPages } from '@octo-draw/core'
import { describe, expect, it } from 'vitest'
import { checkDocument } from '../../test/helpers'
import { expandNode, getExpander } from '../../expand'
import { resolveSource, scanAny } from '../index'
import { ConnectorError, type ConnectorContext } from '../types'
import { fakeHub, type FakeHubOptions } from './fakeHub.test-util'
import { expandHuggingface, huggingfaceConnector, resolveSrc, scanHuggingface } from './index'

function ctx(opts: FakeHubOptions = {}, env: Record<string, string> = {}) {
	const hub = fakeHub(opts)
	const c: ConnectorContext = { fetch: hub.fetch, env }
	return { ctx: c, calls: hub.calls }
}

/** Parses with core (pages + cross-page checks), lays out every page, and checks drills. */
async function valid(code: string) {
	const parsed = parseOctoPages(code)
	const errors = [...parsed.diagnostics, ...parsed.pages.flatMap((p) => p.diagnostics)].filter((d) => d.severity === 'error')
	expect(errors).toEqual([])
	expect(parsed.diagnostics.filter((d) => /drill/.test(d.message))).toEqual([])
	expect(checkDocument(code).problems).toEqual([])
	for (const p of parsed.pages) {
		const layout = await layoutDiagram(p.ir)
		expect(Object.keys(layout.nodes).length).toBe(p.ir.nodes.length)
	}
	return parsed
}

const scan = async (input: string, opts: FakeHubOptions = {}, env: Record<string, string> = {}, options: Record<string, unknown> = {}) => {
	const { ctx: c, calls } = ctx(opts, env)
	const ref = huggingfaceConnector.parse(input)!
	const r = await scanHuggingface({ ...ref, options: { ...ref.options, ...options } }, c)
	return { ...r, calls }
}

const page = (parsed: ReturnType<typeof parseOctoPages>, name: string) => parsed.pages.find((p) => p.name === name)!
const node = (parsed: ReturnType<typeof parseOctoPages>, pageName: string, key: string) => page(parsed, pageName).ir.nodes.find((n) => n.key === key)

describe('huggingface connector (mocked Hub)', () => {
	it('is registered and resolves inputs', () => {
		expect(resolveSource('hf:Qwen/Qwen2.5-7B')?.connector.kind).toBe('huggingface')
		expect(resolveSource('https://huggingface.co/datasets/stanfordnlp/imdb')?.ref).toMatchObject({ kind: 'huggingface', id: 'stanfordnlp/imdb' })
		expect(resolveSource('github.com/o/r')?.connector.kind).toBe('github')
		expect(getExpander('huggingface')).toBeTypeOf('function')
	})

	it('Llama-style model: lineage-free root, Architecture page, source + src refs', async () => {
		const r = await scan('hf:meta-llama/Llama-3.1-8B', {}, { HF_TOKEN: 'hf_test' })
		const parsed = await valid(r.code)
		expect(r.code).toMatch(/^title meta-llama\/Llama-3.1-8B\n(source|\/\/ source) hf:meta-llama\/Llama-3.1-8B\n/)
		expect(parsed.pages.map((p) => p.name)).toEqual(['', 'Architecture'])
		const model = node(parsed, '', 'meta-llama/Llama-3.1-8B')!
		expect(model.label).toBe('Llama-3.1-8B · 8.03B params · gated')
		expect(model.icon).toBe('huggingface')
		expect(model.ext?.src).toBe('hf:meta-llama/Llama-3.1-8B')
		expect(node(parsed, '', 'Architecture')?.ext?.drill).toBe('Architecture')
		const dec = node(parsed, 'Architecture', 'Decoder')!
		expect(dec.isContainer).toBe(true)
		expect(dec.label).toBe('Decoder × 32 layers')
		expect(dec.ext?.src).toBe('hf:meta-llama/Llama-3.1-8B#decoder')
		expect(node(parsed, 'Architecture', 'Self-attention')?.label).toBe('Self-attention · GQA 32 heads / 8 KV · head dim 128 · RoPE θ=500,000')
		expect(node(parsed, 'Architecture', 'MLP')?.label).toBe('SwiGLU MLP · 4,096 → 14,336')
		// every node carries a src
		for (const p of parsed.pages) for (const n of p.ir.nodes) expect(n.ext?.src, `${p.name}/${n.key}`).toMatch(/^hf:/)
		// the token is sent to the Hub only
		expect(r.calls.every((c) => c.auth === 'Bearer hf_test')).toBe(true)
		expect(r.code).not.toContain('hf_test')
		expect(r.warnings).toEqual([])
	})

	it('gated config without HF_TOKEN degrades to a note', async () => {
		const r = await scan('hf:meta-llama/Llama-3.1-8B', { gated: ['meta-llama/Llama-3.1-8B/config.json'] })
		const parsed = await valid(r.code)
		expect(parsed.pages.map((p) => p.name)).toEqual([''])
		expect(node(parsed, '', 'Architecture')?.label).toContain('config.json is gated')
		expect(r.warnings.join(' ')).toMatch(/gated: set HF_TOKEN/)
		expect(r.calls.every((c) => c.auth === undefined)).toBe(true)
	})

	it('Qwen finetune: base model lineage with relation labels', async () => {
		const r = await scan('huggingface.co/Qwen/Qwen2.5-7B-Instruct')
		const parsed = await valid(r.code)
		const root = page(parsed, '')
		expect(root.ir.edges.find((e) => e.from === 'Qwen/Qwen2.5-7B' && e.to === 'Qwen/Qwen2.5-7B-Instruct')?.label).toBe('fine-tuned into')
		expect(node(parsed, '', 'License')?.label).toBe('License: apache-2.0')
		expect(node(parsed, '', 'Task')?.label).toBe('Task: text-generation')
		expect(node(parsed, '', 'Library')?.icon).toBe('huggingface')
		expect(r.findings[0]).toMatchObject({ analyzer: 'huggingface', confidence: 0.9 })
	})

	it('Mixtral: MoE in the architecture; depth 3 pre-generates block, attention and router pages', async () => {
		const r1 = await scan('hf:mistralai/Mixtral-8x7B-v0.1')
		const p1 = await valid(r1.code)
		expect(node(p1, 'Architecture', 'MoE')?.label).toBe('MoE · 8 experts, top-2 · 4,096 → 14,336')
		expect(node(p1, 'Architecture', 'Parameters')?.label).toContain('46.7B parameters')
		const r3 = await scan('hf:mistralai/Mixtral-8x7B-v0.1', {}, {}, { depth: 3 })
		const p3 = await valid(r3.code)
		expect(p3.pages.map((p) => p.name)).toEqual(['', 'Architecture', 'Architecture / Decoder', 'Architecture / Decoder / Causal self-attention', 'Architecture / Decoder / MoE'])
		expect(node(p3, 'Architecture', 'Decoder')?.ext?.drill).toBe('Architecture / Decoder')
		expect(node(p3, 'Architecture', 'MoE')?.ext?.drill).toBe('Architecture / Decoder / MoE')
		expect(node(p3, 'Architecture / Decoder / MoE', 'Router')?.label).toBe('Router · linear 4,096 → 8 · softmax · top-2')
		expect(node(p3, 'Architecture / Decoder / Causal self-attention', 'KV cache')?.shape).toBe('cylinder')
	})

	it('llava: vision tower, projector and merge', async () => {
		const r = await scan('hf:llava-hf/llava-1.5-7b-hf')
		const parsed = await valid(r.code)
		expect(node(parsed, 'Architecture', 'Vision encoder')?.label).toBe('CLIP ViT × 24 layers')
		expect(node(parsed, 'Architecture', 'Projector')?.label).toBe('MLP projector (GELU) · 1,024 → 4,096')
		const arch = page(parsed, 'Architecture')
		expect(arch.ir.edges.some((e) => e.from === 'Projector' && e.to === 'Merge')).toBe(true)
		expect(node(parsed, '', 'Training data')?.isContainer).toBe(true)
		expect(r.warnings.join(' ')).toContain('llama defaults')
	})

	it('T5 and Whisper: encoder → decoder with cross-attention', async () => {
		for (const [id, input] of [
			['google-t5/t5-base', 'Input tokens'],
			['openai/whisper-large-v3', 'Audio'],
		]) {
			const r = await scan(`hf:${id}`)
			const parsed = await valid(r.code)
			const arch = page(parsed, 'Architecture')
			expect(arch.ir.nodes.map((n) => n.key)).toEqual(expect.arrayContaining([input, 'Encoder', 'Decoder', 'Cross-attention', 'LM head']))
			expect(arch.ir.edges.find((e) => e.to === 'Cross-attention' && e.from === 'Encoder final norm')?.label).toBe('keys / values')
		}
	})

	it('SDXL diffusers: pipeline page from model_index.json', async () => {
		const r = await scan('hf:stabilityai/stable-diffusion-xl-base-1.0')
		const parsed = await valid(r.code)
		expect(node(parsed, '', 'Pipeline')?.ext?.drill).toBe('Pipeline')
		const pp = page(parsed, 'Pipeline')
		const e = (from: string, to: string) => pp.ir.edges.some((x) => x.from === from && x.to === to)
		expect(e('Prompt', 'tokenizer') && e('tokenizer', 'text encoder') && e('text encoder', 'unet') && e('text encoder 2', 'unet') && e('unet', 'vae') && e('vae', 'Output') && e('scheduler', 'unet')).toBe(true)
		expect(node(parsed, 'Pipeline', 'unet')?.label).toContain('channels 320/640/1280')
	})

	it('GGUF and adapter-only repos get a note', async () => {
		const g = await scan('hf:bartowski/Meta-Llama-3.1-8B-Instruct-GGUF')
		const pg = await valid(g.code)
		expect(node(pg, '', 'GGUF')?.label).toMatch(/^GGUF for llama.cpp · 24 quantizations: IQ2_M/)
		expect(page(pg, '').ir.edges.find((e) => e.from === 'meta-llama/Llama-3.1-8B-Instruct')?.label).toBe('quantized to')
		const a = await scan('hf:tloen/alpaca-lora-7b')
		const pa = await valid(a.code)
		expect(node(pa, '', 'Adapter')?.label).toBe('LORA adapter · r=16 · α=16 · on q_proj, k_proj, v_proj, o_proj · CAUSAL_LM')
		expect(page(pa, '').ir.edges.find((e) => e.from === 'decapoda-research/llama-7b-hf')?.label).toBe('LORA adapter')
	})

	it('dataset: configs, splits, features, trained models', async () => {
		const r = await scan('https://huggingface.co/datasets/stanfordnlp/imdb')
		const parsed = await valid(r.code)
		expect(parsed.pages.map((p) => p.name)).toEqual(['', 'Config plain_text'])
		expect(node(parsed, '', 'stanfordnlp/imdb')?.label).toBe('IMDB · 100K rows · 126 MB')
		expect(node(parsed, 'Config plain_text', 'split train')?.label).toBe('train · 25,000 rows · 31.7 MB')
		expect(node(parsed, 'Config plain_text', 'feature label')?.label).toBe('label: ClassLabel(neg, pos)')
		expect(page(parsed, '').ir.nodes.filter((n) => n.parent === 'Trained models')).toHaveLength(3)
		expect(r.code).toContain('source hf:datasets/stanfordnlp/imdb')
	})

	it('gradio Space: request flow user → UI → handler → model calls → outputs', async () => {
		const r = await scan('huggingface.co/spaces/acme/rag-chat')
		const parsed = await valid(r.code)
		const root = page(parsed, '')
		const e = (from: string, to: string) => root.ir.edges.find((x) => x.from === from && x.to === to)
		expect(e('User', 'UI')).toBeDefined()
		expect(e('UI', 'respond()')?.label).toBe('event')
		expect(e('respond()', 'meta-llama/Llama-3.1-8B-Instruct')?.label).toBe('inference')
		expect(e('respond()', 'OpenAI API')?.label).toBe('API call')
		expect(e('respond()', 'Chroma')?.label).toBe('retrieve')
		expect(e('meta-llama/Llama-3.1-8B-Instruct', 'Outputs')).toBeDefined()
		expect(node(parsed, '', 'Outputs')?.label).toBe('Chat reply')
		expect(node(parsed, '', 'Space')?.label).toBe('Space acme/rag-chat · gradio 5.9.1 · cpu-upgrade')
		expect(node(parsed, '', 'meta-llama/Llama-3.1-8B-Instruct')?.ext?.src).toBe('hf:meta-llama/Llama-3.1-8B-Instruct')
		expect(node(parsed, '', 'dataset acme/handbook')).toBeDefined()
		expect(parsed.pages.map((p) => p.name)).toEqual(['', 'App code'])
	})

	it('collection: a page per item type', async () => {
		const r = await scan('https://huggingface.co/collections/Qwen/qwen25-66e81a666513e518adb90d9e')
		const parsed = await valid(r.code)
		expect(parsed.pages.map((p) => p.name)).toEqual(['', 'Papers', 'Models'])
		expect(node(parsed, 'Models', 'model Qwen/Qwen2.5-0.5B')?.link).toBe('https://huggingface.co/Qwen/Qwen2.5-0.5B')
		expect(node(parsed, 'Papers', 'paper 2412.15115')?.link).toBe('https://huggingface.co/papers/2412.15115')
	})

	it('errors: not found, gated (403), rate limit', async () => {
		await expect(scan('hf:nobody/nothing')).rejects.toMatchObject({ status: 404, message: expect.stringMatching(/not found, or it is private or gated/) })
		await expect(scan('hf:a/b', { status: 403 })).rejects.toMatchObject({ status: 403, message: expect.stringMatching(/gated \(403\)/) })
		await expect(scan('hf:a/b', { status: 401 }, { HF_TOKEN: 'x' })).rejects.toMatchObject({ status: 401 })
		const err = await scan('hf:a/b', { rateLimited: true }).catch((e) => e)
		expect(err).toBeInstanceOf(ConnectorError)
		expect(err.status).toBe(429)
		expect(err.message).toMatch(/rate limit.*42s.*HF_TOKEN/)
	})

	it('scanAny dispatches hf inputs', async () => {
		const { ctx: c } = ctx()
		const r = await scanAny('hf:google-t5/t5-base', c)
		expect(r.source).toEqual({ kind: 'huggingface', id: 'google-t5/t5-base', options: { type: 'model' } })
	})
})

describe('huggingface expansion', () => {
	const expand = async (src: string, label: string, depth = 1) => {
		const { ctx: c } = ctx()
		const r = await expandHuggingface({ src, node: { key: label, label }, parentPage: 'Architecture', depth }, c)
		await valid(r.body)
		return { ...r, parsed: parseOctoPages(r.body) }
	}

	it('resolves absolute and relative srcs', () => {
		expect(resolveSrc('hf:org/m#decoder.attn')).toMatchObject({ ref: { id: 'org/m' }, path: 'decoder.attn' })
		expect(resolveSrc('#decoder', 'hf:org/m')).toMatchObject({ ref: { id: 'org/m' }, path: 'decoder' })
		expect(resolveSrc('hf:datasets/a/b#config/x')).toMatchObject({ ref: { id: 'a/b', options: { type: 'dataset' } }, path: 'config/x' })
		expect(resolveSrc('#x')).toBeNull()
	})

	it('model → block → sublayer', async () => {
		const block = await expand('hf:meta-llama/Llama-3.1-8B#decoder', 'Decoder')
		const keys = block.parsed.pages[0].ir.nodes.map((n) => n.key)
		expect(keys).toEqual(expect.arrayContaining(['Pre-attention norm', 'Causal self-attention', 'Add 1', 'Pre-MLP norm', 'MLP', 'Add 2']))
		const attn = await expand('hf:meta-llama/Llama-3.1-8B#decoder.attn', 'Self-attention')
		const a = attn.parsed.pages[0].ir
		expect(a.nodes.find((n) => n.key === 'K proj')?.label).toBe('K proj · 4,096 → 8 × 128')
		expect(a.nodes.find((n) => n.key === 'RoPE')?.label).toBe('RoPE on Q and K · θ=500,000 · llama3 ×8 scaling')
		const mlp = await expand('hf:meta-llama/Llama-3.1-8B#decoder.mlp', 'MLP')
		expect(mlp.parsed.pages[0].ir.nodes.map((n) => n.key)).toEqual(expect.arrayContaining(['Gate proj', 'Up proj', 'Activation', 'Multiply', 'Down proj']))
		const cross = await expand('hf:openai/whisper-large-v3#decoder.cross', 'Cross-attention')
		expect(cross.parsed.pages[0].ir.nodes.some((n) => n.key === 'Encoder output')).toBe(true)
	})

	it('depth > 1 returns several pages', async () => {
		const r = await expand('hf:mistralai/Mixtral-8x7B-v0.1#decoder', 'Decoder', 2)
		expect(r.parsed.pages.map((p) => p.name)).toEqual(['', 'Decoder / Causal self-attention', 'Decoder / MoE'])
	})

	it('diffusers components, a base model, a dataset config and a Space handler', async () => {
		const unet = await expand('hf:stabilityai/stable-diffusion-xl-base-1.0#unet/', 'unet')
		expect(unet.parsed.pages[0].ir.nodes.find((n) => n.key === 'Down 2')?.label).toBe('CrossAttnDownBlock2D · 640 ch')
		const base = await expand('hf:Qwen/Qwen2.5-7B-Instruct', 'Qwen2.5-7B-Instruct')
		expect(base.parsed.pages.map((p) => p.name)).toEqual(['', 'Qwen2.5-7B-Instruct / Architecture'])
		const cfg = await expand('hf:datasets/stanfordnlp/imdb#config/plain_text', 'plain_text')
		expect(cfg.parsed.pages[0].ir.nodes.filter((n) => n.parent === 'Splits')).toHaveLength(3)
		const handler = await expand('hf:spaces/acme/rag-chat#app/respond', 'respond()')
		expect(handler.parsed.pages[0].ir.nodes.map((n) => n.key)).toEqual(expect.arrayContaining(['meta-llama/Llama-3.1-8B-Instruct', 'moderate()']))
	})

	it('works through the shared expandNode registry with depth', async () => {
		const { ctx: c } = ctx()
		const r = await expandNode({ source: 'hf:mistralai/Mixtral-8x7B-v0.1', src: 'hf:mistralai/Mixtral-8x7B-v0.1#architecture', node: { key: 'Architecture' }, parentPage: '', depth: 2 }, c)
		expect(r.pages[0]).toBe('Architecture')
		expect(r.pages.length).toBeGreaterThan(1)
		await valid(r.body)
	})
})

describe('token safety', () => {
	it('never sends HF_TOKEN to a non-Hub endpoint', async () => {
		const calls: { url: string; auth?: string }[] = []
		const f = (async (input: string | URL | Request, init?: RequestInit) => {
			calls.push({ url: String(input), auth: (init?.headers as Record<string, string>)?.Authorization })
			return new Response('{}', { status: 404 })
		}) as typeof fetch
		await expect(scanHuggingface({ kind: 'huggingface', id: 'a/b', options: { type: 'model', endpoint: 'https://evil.example' } }, { fetch: f, env: { HF_TOKEN: 'secret' } })).rejects.toMatchObject({ status: 404 })
		expect(calls[0].url).toBe('https://evil.example/api/models/a/b')
		expect(calls[0].auth).toBeUndefined()
	})
})
