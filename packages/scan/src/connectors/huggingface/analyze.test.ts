import { describe, expect, it } from 'vitest'
import { analyzeModelIndex } from './diffusers'
import { analyzeConfig, specSummary } from './config'
import { baseModels, datasetsOf, parseFrontMatter } from './card'
import { fixtureJson, fixtureText } from './fakeHub.test-util'
import { estimateParams } from './params'
import { parseHuggingface } from './parse'
import { analyzeApp, parseRequirements } from './space'

const cfg = (id: string) => analyzeConfig(fixtureJson(`models/${id.replace('/', '__')}/config.json`))!
const within = (got: number, want: number, pct: number) => expect(Math.abs(got - want) / want).toBeLessThan(pct / 100)

describe('parseHuggingface', () => {
	it('accepts hf: shorthands and huggingface.co URLs', () => {
		expect(parseHuggingface('hf:Qwen/Qwen2.5-7B')).toEqual({ kind: 'huggingface', id: 'Qwen/Qwen2.5-7B', options: { type: 'model' } })
		expect(parseHuggingface('hf:gpt2')).toMatchObject({ id: 'gpt2', options: { type: 'model' } })
		expect(parseHuggingface('huggingface.co/mistralai/Mixtral-8x7B-v0.1')).toMatchObject({ id: 'mistralai/Mixtral-8x7B-v0.1', options: { type: 'model' } })
		expect(parseHuggingface('https://huggingface.co/openai/whisper-large-v3/tree/main')).toMatchObject({ id: 'openai/whisper-large-v3', ref: 'main' })
		expect(parseHuggingface('https://huggingface.co/openai/whisper-large-v3/blob/abc123/config.json')).toMatchObject({ id: 'openai/whisper-large-v3', ref: 'abc123' })
		expect(parseHuggingface('https://www.hf.co/Qwen/Qwen2.5-7B?x=1#readme')).toMatchObject({ id: 'Qwen/Qwen2.5-7B' })
		expect(parseHuggingface('huggingface.co/datasets/stanfordnlp/imdb')).toMatchObject({ id: 'stanfordnlp/imdb', options: { type: 'dataset' } })
		expect(parseHuggingface('hf:datasets/stanfordnlp/imdb@refs%2Fconvert%2Fparquet')).toMatchObject({ id: 'stanfordnlp/imdb', ref: 'refs/convert/parquet', options: { type: 'dataset' } })
		expect(parseHuggingface('https://huggingface.co/spaces/black-forest-labs/FLUX.1-dev')).toMatchObject({ id: 'black-forest-labs/FLUX.1-dev', options: { type: 'space' } })
		expect(parseHuggingface('https://huggingface.co/collections/Qwen/qwen25-66e81a666513e518adb90d9e')).toMatchObject({ id: 'Qwen/qwen25-66e81a666513e518adb90d9e', options: { type: 'collection' } })
		expect(parseHuggingface('hf:Qwen/Qwen2.5-7B@v1')).toMatchObject({ ref: 'v1' })
	})

	it('rejects other inputs', () => {
		for (const s of ['github.com/o/r', 'o/r', 'huggingface.co', 'huggingface.co/docs/hub', 'huggingface.co/gpt2', 'https://huggingface.co/models?search=x', 'hf:', './local/dir']) expect(parseHuggingface(s), s).toBeNull()
	})
})

describe('analyzeConfig', () => {
	it('llama-style: GQA, rope scaling, SwiGLU', () => {
		const s = cfg('meta-llama/Llama-3.1-8B')
		expect(s.family).toBe('decoder')
		const d = s.decoder!
		expect(d).toMatchObject({ layers: 32, hidden: 4096, norm: 'RMSNorm', causal: true })
		expect(d.attn).toMatchObject({ heads: 32, kvHeads: 8, headDim: 128, variant: 'GQA', pos: 'rope', ropeTheta: 500000, ropeScaling: 'llama3 ×8' })
		expect(d.mlp).toEqual({ intermediate: 14336, act: 'silu', gated: true })
		expect(s.tied).toBe(false)
		within(estimateParams(s).total, 8_030_261_248, 1)
	})

	it('qwen2 matches safetensors totals', () => {
		const s = cfg('Qwen/Qwen2.5-7B-Instruct')
		expect(s.decoder!.attn).toMatchObject({ heads: 28, kvHeads: 4, bias: true })
		within(estimateParams(s).total, 7_615_616_512, 1)
	})

	it('mixtral MoE: experts, top-k, active params', () => {
		const s = cfg('mistralai/Mixtral-8x7B-v0.1')
		expect(s.decoder!.moe).toEqual({ experts: 8, topK: 2 })
		const p = estimateParams(s)
		within(p.total, 46_702_792_704, 1)
		within(p.active!, 12_900_000_000, 3)
		expect(specSummary(s)).toContain('MoE 8×top-2')
	})

	it('llava VLM: vision tower + projector, llama defaults for a sparse text_config', () => {
		const s = cfg('llava-hf/llava-1.5-7b-hf')
		expect(s.family).toBe('vlm')
		expect(s.vision).toMatchObject({ modelType: 'clip_vision_model', imageSize: 336, patchSize: 14, patches: 576 })
		expect(s.vision!.stack).toMatchObject({ layers: 24, hidden: 1024 })
		expect(s.projector).toMatchObject({ kind: 'MLP', act: 'gelu', from: 1024, to: 4096 })
		expect(s.decoder).toMatchObject({ layers: 32, hidden: 4096 })
		expect(s.assumed.join(' ')).toContain('llama defaults')
		within(estimateParams(s).total, 7_063_427_072, 3)
	})

	it('T5 encoder-decoder: relative position bias, RMS-style norm, tied', () => {
		const s = cfg('google-t5/t5-base')
		expect(s.family).toBe('encoder-decoder')
		expect(s.encoder).toMatchObject({ layers: 12, hidden: 768, norm: 'RMSNorm', causal: false })
		expect(s.decoder).toMatchObject({ layers: 12, cross: true, causal: true })
		expect(s.encoder!.attn).toMatchObject({ heads: 12, headDim: 64, pos: 'relative' })
		expect(s.encoder!.mlp).toEqual({ intermediate: 3072, act: 'relu', gated: false })
		within(estimateParams(s).total, 222_903_936, 3)
	})

	it('Whisper: audio encoder-decoder', () => {
		const s = cfg('openai/whisper-large-v3')
		expect(s).toMatchObject({ family: 'encoder-decoder', input: 'audio', melBins: 128, vocab: 51866 })
		expect(s.encoder).toMatchObject({ layers: 32, hidden: 1280, norm: 'LayerNorm' })
		expect(s.encoder!.attn.pos).toBe('sinusoidal')
		within(estimateParams(s).total, 1_543_490_560, 2)
	})

	it('handles odd inputs', () => {
		expect(analyzeConfig(null)).toBeNull()
		expect(analyzeConfig({ foo: 1 })).toBeNull()
		const gpt2 = analyzeConfig({ model_type: 'gpt2', n_embd: 768, n_layer: 12, n_head: 12, vocab_size: 50257, n_positions: 1024, activation_function: 'gelu_new' })!
		expect(gpt2.decoder).toMatchObject({ layers: 12, hidden: 768, norm: 'LayerNorm' })
		expect(gpt2.decoder!.attn.pos).toBe('learned')
		expect(gpt2.decoder!.mlp.gated).toBe(false)
		within(estimateParams(gpt2).total, 124_000_000, 5)
		const bert = analyzeConfig({ architectures: ['BertForMaskedLM'], model_type: 'bert' })!
		expect(bert.family).toBe('encoder')
		expect(bert.encoder).toMatchObject({ layers: 12, hidden: 768, postNorm: true })
		const ds = analyzeConfig({ model_type: 'deepseek_v3', hidden_size: 7168, num_hidden_layers: 61, num_attention_heads: 128, num_key_value_heads: 128, kv_lora_rank: 512, n_routed_experts: 256, num_experts_per_tok: 8, n_shared_experts: 1, moe_intermediate_size: 2048, intermediate_size: 18432, first_k_dense_replace: 3, vocab_size: 129280, qk_nope_head_dim: 128 })!
		expect(ds.decoder!.attn.variant).toBe('MLA')
		expect(ds.decoder!.moe).toMatchObject({ experts: 256, topK: 8, shared: 1, expertIntermediate: 2048, denseLayers: 3 })
	})
})

describe('analyzeModelIndex', () => {
	it('reads the SDXL pipeline', () => {
		const p = analyzeModelIndex(fixtureJson('models/stabilityai__stable-diffusion-xl-base-1.0/model_index.json'))!
		expect(p.cls).toBe('StableDiffusionXLPipeline')
		expect(p.output).toBe('image')
		expect(p.imageInput).toBe(false)
		const roles = Object.fromEntries(p.components.map((c) => [c.name, c.role]))
		expect(roles).toEqual({ scheduler: 'scheduler', text_encoder: 'text_encoder', text_encoder_2: 'text_encoder', tokenizer: 'tokenizer', tokenizer_2: 'tokenizer', unet: 'denoiser', vae: 'vae' })
		expect(analyzeModelIndex({ nope: true })).toBeNull()
	})
})

describe('cards', () => {
	it('parses YAML front matter', () => {
		const fm = parseFrontMatter('---\nlicense: apache-2.0\nbase_model: Qwen/Qwen2.5-7B\ndatasets:\n  - a/b\n---\n# Title\n')
		expect(fm).toEqual({ license: 'apache-2.0', base_model: 'Qwen/Qwen2.5-7B', datasets: ['a/b'] })
		expect(parseFrontMatter('# no front matter')).toEqual({})
	})

	it('prefers the Hub relation tags (they follow renames)', () => {
		const gguf = fixtureJson<{ cardData: Record<string, unknown>; tags: string[] }>('models/bartowski__Meta-Llama-3.1-8B-Instruct-GGUF/api.json')
		expect(baseModels(gguf.cardData, gguf.tags)).toEqual([{ id: 'meta-llama/Llama-3.1-8B-Instruct', relation: 'quantized' }])
		expect(baseModels({ base_model: ['a/x', 'b/y'] }, [])).toEqual([
			{ id: 'a/x', relation: 'merge' },
			{ id: 'b/y', relation: 'merge' },
		])
		expect(baseModels({ base_model: 'a/x' }, [])).toEqual([{ id: 'a/x', relation: 'base' }])
		expect(datasetsOf({ datasets: ['c4'] }, ['dataset:c4', 'dataset:x/y'])).toEqual(['c4', 'x/y'])
	})
})

describe('analyzeApp', () => {
	const dir = 'spaces/acme__rag-chat'
	const files = new Map(['app.py', 'retriever.py', 'requirements.txt'].map((f) => [f, fixtureText(`${dir}/${f}`)]))

	it('finds model calls, APIs, vector DBs and the UI of a RAG chat Space', () => {
		const a = analyzeApp(files, 'gradio')
		expect(a.framework).toBe('gradio')
		expect(a.ui).toBe('ChatInterface')
		expect(a.handlers).toEqual(['respond'])
		const targets = a.calls.map((c) => `${c.target}|${c.kind}`)
		expect(targets).toContain('meta-llama/Llama-3.1-8B-Instruct|inference')
		expect(targets).toContain('BAAI/bge-small-en-v1.5|local')
		expect(targets).toContain('OpenAI API|api')
		expect(a.externals.map((e) => e.name)).toEqual(expect.arrayContaining(['Chroma', 'sentence-transformers']))
		expect(a.datasets).toEqual(['acme/handbook'])
		expect(a.outputs).toEqual(['Chatbot'])
	})

	it('reads diffusers pipelines and ZeroGPU handlers (FLUX.1-dev)', () => {
		const flux = new Map(['app.py', 'requirements.txt'].map((f) => [f, fixtureText(`spaces/black-forest-labs__FLUX.1-dev/${f}`)]))
		const a = analyzeApp(flux, 'gradio')
		expect(a.gpuHandlers).toEqual(['infer'])
		expect(a.handlers).toContain('infer')
		expect(a.calls.map((c) => c.target)).toEqual(['madebyollin/taef1', 'black-forest-labs/FLUX.1-dev'])
		expect(a.calls[1].via).toContain('DiffusionPipeline.from_pretrained')
		expect(a.outputs).toEqual(['Image'])
	})

	it('parses requirements', () => {
		expect(parseRequirements('gradio==5.0\n# c\n-r other.txt\ngit+https://github.com/huggingface/diffusers.git\nsentence_transformers>=2\n')).toEqual(['gradio', 'diffusers', 'sentence-transformers'])
	})

	it('streamlit apps', () => {
		const a = analyzeApp(new Map([['app.py', 'import streamlit as st\nfrom transformers import pipeline\npipe = pipeline("summarization", model="facebook/bart-large-cnn")\ntext = st.text_area("Text")\nst.write(pipe(text))\n']]), 'streamlit')
		expect(a.framework).toBe('streamlit')
		expect(a.inputs).toEqual(['Text area'])
		expect(a.calls).toEqual([{ target: 'facebook/bart-large-cnn', via: 'pipeline("summarization")', kind: 'local', task: 'summarization' }])
	})
})
