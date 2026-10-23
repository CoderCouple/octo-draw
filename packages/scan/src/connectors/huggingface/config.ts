/**
 * `config.json` (transformers) → a normalized architecture spec. Pure.
 *
 * Covers the common families through field aliases: decoder-only LMs
 * (llama/mistral/qwen/gemma/phi/gpt2/falcon/...), MoE (mixtral, qwen-moe,
 * deepseek, dbrx-style fields), VLMs with `vision_config` + `text_config`
 * (llava, qwen-vl, idefics, gemma3, ...), encoder-decoders (t5, bart,
 * whisper, marian) and encoder-only models (bert, roberta, deberta).
 * Missing fields fall back to the transformers defaults of the model type,
 * and every assumption is reported in `assumed`.
 */

import { asArr, asObj, asStr, isObj, type Obj } from '../../util'

export type Family = 'decoder' | 'encoder' | 'encoder-decoder' | 'vlm'
export type NormType = 'RMSNorm' | 'LayerNorm'
export type PosEmb = 'rope' | 'alibi' | 'learned' | 'relative' | 'sinusoidal' | 'none'

export interface AttnSpec {
	heads: number
	kvHeads: number
	headDim: number
	/** MHA / GQA / MQA / MLA. */
	variant: 'MHA' | 'GQA' | 'MQA' | 'MLA'
	pos: PosEmb
	ropeTheta?: number
	ropeScaling?: string
	slidingWindow?: number
	/** MLA latent KV rank (deepseek). */
	kvLoraRank?: number
	bias?: boolean
}

export interface MlpSpec {
	intermediate: number
	act: string
	gated: boolean
}

export interface MoeSpec {
	experts: number
	topK: number
	shared?: number
	/** Per-expert intermediate size when it differs from the dense MLP. */
	expertIntermediate?: number
	/** First N layers stay dense (deepseek `first_k_dense_replace`). */
	denseLayers?: number
}

export interface StackSpec {
	name: string
	layers: number
	hidden: number
	attn: AttnSpec
	mlp: MlpSpec
	moe?: MoeSpec
	norm: NormType
	normEps?: number
	/** Decoder layers of an encoder-decoder also attend to the encoder output. */
	cross?: boolean
	/** Causal self-attention (decoders). */
	causal: boolean
	/** Norm after the residual add (BERT, BART) instead of before the sublayer. */
	postNorm?: boolean
}

export interface VisionSpec {
	modelType: string
	stack: StackSpec
	imageSize?: number
	patchSize?: number
	/** Patches per image (`(image/patch)^2`). */
	patches?: number
}

export interface ProjectorSpec {
	kind: string
	act?: string
	from: number
	to: number
}

export interface ArchSpec {
	family: Family
	modelType: string
	architecture?: string
	vocab?: number
	maxPositions?: number
	tied: boolean
	dtype?: string
	input: 'tokens' | 'audio' | 'image'
	melBins?: number
	encoder?: StackSpec
	decoder?: StackSpec
	vision?: VisionSpec
	projector?: ProjectorSpec
	/** Fields filled from defaults (shown as a warning / note). */
	assumed: string[]
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && /^\d+(\.\d+)?$/.test(v) ? Number(v) : undefined)

function pick(c: Obj, keys: string[]): number | undefined {
	for (const k of keys) {
		const v = num(c[k])
		if (v !== undefined) return v
	}
	return undefined
}

/** transformers defaults for configs that only list overrides (llava `text_config` etc.). */
const DEFAULTS: Record<string, Obj> = {
	llama: { vocab_size: 32000, hidden_size: 4096, intermediate_size: 11008, num_hidden_layers: 32, num_attention_heads: 32, hidden_act: 'silu', max_position_embeddings: 2048, rms_norm_eps: 1e-6, rope_theta: 10000 },
	mistral: { vocab_size: 32000, hidden_size: 4096, intermediate_size: 14336, num_hidden_layers: 32, num_attention_heads: 32, num_key_value_heads: 8, hidden_act: 'silu', max_position_embeddings: 131072, rms_norm_eps: 1e-6, rope_theta: 10000 },
	qwen2: { vocab_size: 151936, hidden_size: 4096, intermediate_size: 22016, num_hidden_layers: 32, num_attention_heads: 32, num_key_value_heads: 32, hidden_act: 'silu', rms_norm_eps: 1e-6, rope_theta: 10000 },
	vicuna: {},
	clip_vision_model: { hidden_size: 768, intermediate_size: 3072, num_hidden_layers: 12, num_attention_heads: 12, image_size: 224, patch_size: 32, hidden_act: 'quick_gelu', layer_norm_eps: 1e-5 },
	siglip_vision_model: { hidden_size: 768, intermediate_size: 3072, num_hidden_layers: 12, num_attention_heads: 12, image_size: 224, patch_size: 16, hidden_act: 'gelu_pytorch_tanh', layer_norm_eps: 1e-6 },
	t5: { vocab_size: 32128, d_model: 512, d_kv: 64, d_ff: 2048, num_layers: 6, num_heads: 8, feed_forward_proj: 'relu' },
	bert: { vocab_size: 30522, hidden_size: 768, num_hidden_layers: 12, num_attention_heads: 12, intermediate_size: 3072, hidden_act: 'gelu', max_position_embeddings: 512, layer_norm_eps: 1e-12 },
}

const GATED_TYPES = new Set(['llama', 'mistral', 'mixtral', 'qwen2', 'qwen2_moe', 'qwen3', 'qwen3_moe', 'gemma', 'gemma2', 'gemma3', 'gemma3_text', 'phi3', 'phimoe', 'deepseek', 'deepseek_v2', 'deepseek_v3', 'olmo', 'olmo2', 'olmoe', 'cohere', 'cohere2', 'granite', 'granitemoe', 'internlm2', 'yi', 'baichuan', 'exaone', 'glm', 'glm4', 'minicpm', 'jamba', 'dbrx', 'arctic', 'smollm3', 'hunyuan', 'ernie4_5', 'gpt_oss'])
const ENC_DEC_TYPES = new Set(['t5', 'mt5', 'umt5', 'bart', 'mbart', 'whisper', 'marian', 'pegasus', 'm2m_100', 'nllb', 'led', 'blenderbot', 'prophetnet', 'longt5', 'switch_transformers', 'flan-t5', 'seamless_m4t', 'speech_to_text'])
const ENCODER_TYPES = new Set(['bert', 'roberta', 'xlm-roberta', 'deberta', 'deberta-v2', 'distilbert', 'electra', 'albert', 'camembert', 'mpnet', 'modernbert', 'nomic_bert', 'xlm', 'ernie', 'esm', 'vit', 'dinov2', 'beit', 'clip_vision_model', 'siglip_vision_model'])
const POST_NORM_TYPES = new Set(['bert', 'roberta', 'xlm-roberta', 'deberta', 'deberta-v2', 'distilbert', 'electra', 'albert', 'camembert', 'mpnet', 'ernie', 'esm', 'bart', 'marian', 'blenderbot', 'opt-350m'])
const RMS_TYPES = new Set(['t5', 'mt5', 'umt5', 'longt5', 'switch_transformers'])

function withDefaults(c: Obj, assumed: string[], label: string): Obj {
	const mt = asStr(c.model_type) ?? ''
	const d = DEFAULTS[mt]
	if (!d) return c
	const out: Obj = { ...c }
	const filled: string[] = []
	for (const [k, v] of Object.entries(d)) {
		if (out[k] === undefined) {
			out[k] = v
			if (k === 'hidden_size' || k === 'num_hidden_layers' || k === 'intermediate_size' || k === 'num_attention_heads' || k === 'd_model' || k === 'num_layers') filled.push(k)
		}
	}
	if (filled.length) assumed.push(`${label}: ${filled.join(', ')} taken from the ${mt} defaults`)
	return out
}

function posEmb(c: Obj, mt: string): PosEmb {
	const t = asStr(c.position_embedding_type)
	if (t === 'absolute') return 'learned'
	if (t === 'relative_key' || t === 'relative_key_query') return 'relative'
	if (t === 'rotary' || t === 'rope') return 'rope'
	if (c.alibi === true || mt === 'bloom' || mt === 'mpt' || asObj(c.attn_config).alibi === true) return 'alibi'
	if (RMS_TYPES.has(mt) || c.relative_attention_num_buckets !== undefined) return 'relative'
	if (mt === 'whisper') return 'sinusoidal'
	if (c.rope_theta !== undefined || c.rotary_emb_base !== undefined || c.rope_scaling !== undefined || c.rotary_pct !== undefined || c.partial_rotary_factor !== undefined || GATED_TYPES.has(mt) || mt === 'falcon' || mt === 'gptj' || mt === 'gpt_neox' || mt === 'phi' || mt === 'starcoder2' || mt === 'stablelm') return 'rope'
	if (ENCODER_TYPES.has(mt) || mt === 'gpt2' || mt === 'opt' || mt === 'gpt_bigcode' || ENC_DEC_TYPES.has(mt)) return 'learned'
	return 'none'
}

function normOf(c: Obj, mt: string): { norm: NormType; eps?: number } {
	const rms = num(c.rms_norm_eps) ?? num(c.rms_norm_epsilon)
	if (rms !== undefined) return { norm: 'RMSNorm', eps: rms }
	const ln = num(c.layer_norm_eps) ?? num(c.layer_norm_epsilon) ?? num(c.layernorm_epsilon) ?? num(c.norm_eps)
	if (RMS_TYPES.has(mt) || GATED_TYPES.has(mt) || asStr(c.normalization_type)?.toLowerCase().includes('rms')) return { norm: 'RMSNorm', eps: ln }
	return { norm: 'LayerNorm', eps: ln }
}

function actOf(c: Obj, mt: string): { act: string; gated: boolean } {
	const ff = asStr(c.feed_forward_proj)
	if (ff) {
		const gated = ff.startsWith('gated-')
		return { act: gated ? ff.slice(6) : ff, gated }
	}
	const act = asStr(c.hidden_act) ?? asStr(c.hidden_activation) ?? asStr(c.activation_function) ?? asStr(c.activation) ?? (GATED_TYPES.has(mt) ? 'silu' : 'gelu')
	const gated = GATED_TYPES.has(mt) || ((act === 'silu' || act === 'swish' || act === 'swiglu') && !ENCODER_TYPES.has(mt) && mt !== 'gpt2')
	return { act, gated }
}

function attnOf(c: Obj, mt: string, hidden: number, headsKeys: string[]): AttnSpec {
	const heads = pick(c, headsKeys) ?? Math.max(1, Math.round(hidden / 64))
	let kvHeads = pick(c, ['num_key_value_heads', 'num_kv_heads', 'n_head_kv', 'num_kv', 'multi_query_group_num', 'kv_n_heads'])
	if (kvHeads === undefined && (c.multi_query === true || c.multi_query_attention === true)) kvHeads = 1
	if (kvHeads === undefined) kvHeads = heads
	const headDim = pick(c, ['head_dim', 'd_kv', 'attention_head_dim', 'kv_channels']) ?? Math.round(hidden / heads)
	const kvLoraRank = num(c.kv_lora_rank)
	const variant: AttnSpec['variant'] = kvLoraRank ? 'MLA' : kvHeads === heads ? 'MHA' : kvHeads === 1 ? 'MQA' : 'GQA'
	const pos = posEmb(c, mt)
	const scaling = asObj(c.rope_scaling)
	const spec: AttnSpec = { heads, kvHeads, headDim, variant, pos }
	if (pos === 'rope') {
		spec.ropeTheta = num(c.rope_theta) ?? num(c.rotary_emb_base) ?? 10000
		const st = asStr(scaling.rope_type) ?? asStr(scaling.type)
		if (st && st !== 'default') spec.ropeScaling = num(scaling.factor) ? `${st} ×${num(scaling.factor)}` : st
	}
	const window = num(c.sliding_window)
	if (window && c.use_sliding_window !== false) spec.slidingWindow = window
	if (kvLoraRank) spec.kvLoraRank = kvLoraRank
	if (c.attention_bias === true || c.qkv_bias === true || mt === 'qwen2' || mt === 'qwen2_moe') spec.bias = true
	return spec
}

function moeOf(c: Obj): MoeSpec | undefined {
	const experts = pick(c, ['num_local_experts', 'num_experts', 'n_routed_experts', 'moe_num_experts', 'num_experts_routed'])
	if (!experts || experts < 2) return undefined
	const ffn = asObj(c.ffn_config)
	const topK = pick(c, ['num_experts_per_tok', 'moe_top_k', 'top_k', 'num_selected_experts', 'moe_k']) ?? num(ffn.moe_top_k) ?? 2
	const moe: MoeSpec = { experts, topK }
	const shared = pick(c, ['n_shared_experts', 'num_shared_experts'])
	if (shared) moe.shared = shared
	else if (num(c.shared_expert_intermediate_size)) moe.shared = 1
	const ei = pick(c, ['moe_intermediate_size', 'expert_intermediate_size'])
	if (ei) moe.expertIntermediate = ei
	const dense = num(c.first_k_dense_replace)
	if (dense) moe.denseLayers = dense
	return moe
}

/** Decoder-only / encoder-only stack from a flat text config. */
function textStack(c: Obj, name: string, causal: boolean): { stack: StackSpec; vocab?: number; maxPos?: number } {
	const mt = asStr(c.model_type) ?? ''
	const hidden = pick(c, ['hidden_size', 'd_model', 'n_embd', 'dim', 'model_dim', 'hidden_dim']) ?? 768
	const layers = pick(c, ['num_hidden_layers', 'n_layer', 'num_layers', 'n_layers', 'num_hidden_layer']) ?? 12
	const intermediate = pick(c, ['intermediate_size', 'ffn_dim', 'd_ff', 'n_inner', 'ffn_hidden_size', 'mlp_dim', 'hidden_dim']) ?? (mt === 'distilbert' ? 4 * hidden : 4 * hidden)
	const { act, gated } = actOf(c, mt)
	const { norm, eps } = normOf(c, mt)
	const stack: StackSpec = {
		name,
		layers,
		hidden,
		attn: attnOf(c, mt, hidden, ['num_attention_heads', 'n_head', 'num_heads', 'n_heads', 'num_attention_head']),
		mlp: { intermediate: intermediate === hidden && mt === 'distilbert' ? 4 * hidden : intermediate, act, gated },
		norm,
		normEps: eps,
		causal,
	}
	if (POST_NORM_TYPES.has(mt)) stack.postNorm = true
	const moe = moeOf(c)
	if (moe) stack.moe = moe
	return { stack, vocab: pick(c, ['vocab_size', 'n_vocab', 'padded_vocab_size']), maxPos: pick(c, ['max_position_embeddings', 'n_positions', 'max_sequence_length', 'seq_length', 'n_ctx', 'max_seq_len']) }
}

function encDecStacks(c: Obj, mt: string): { encoder: StackSpec; decoder: StackSpec } {
	const hidden = pick(c, ['d_model', 'hidden_size']) ?? 512
	const { act, gated } = actOf(c, mt)
	const { norm, eps } = normOf(c, mt)
	const encLayers = pick(c, ['encoder_layers', 'num_layers', 'num_hidden_layers']) ?? 6
	const decLayers = pick(c, ['decoder_layers', 'num_decoder_layers', 'num_layers', 'num_hidden_layers']) ?? encLayers
	const encHeads = ['encoder_attention_heads', 'num_heads', 'num_attention_heads']
	const decHeads = ['decoder_attention_heads', 'num_heads', 'num_attention_heads']
	const encFfn = pick(c, ['encoder_ffn_dim', 'd_ff', 'intermediate_size']) ?? 4 * hidden
	const decFfn = pick(c, ['decoder_ffn_dim', 'd_ff', 'intermediate_size']) ?? encFfn
	const mk = (name: string, layers: number, heads: string[], ffn: number, decoder: boolean): StackSpec => ({
		name,
		layers,
		hidden,
		attn: attnOf(c, mt, hidden, heads),
		mlp: { intermediate: ffn, act, gated },
		norm,
		normEps: eps,
		cross: decoder,
		causal: decoder,
		...(POST_NORM_TYPES.has(mt) ? { postNorm: true } : {}),
	})
	const out = { encoder: mk('Encoder', encLayers, encHeads, encFfn, false), decoder: mk('Decoder', decLayers, decHeads, decFfn, true) }
	const moe = moeOf(c)
	if (moe) out.encoder.moe = out.decoder.moe = moe
	return out
}

function visionOf(v: Obj, assumed: string[]): VisionSpec {
	const vc = withDefaults(v, assumed, 'vision_config')
	const mt = asStr(vc.model_type) ?? 'vision'
	const { stack } = textStack(vc, 'Vision encoder', false)
	const imageSize = num(vc.image_size) ?? (Array.isArray(vc.image_size) ? num(vc.image_size[0]) : undefined)
	const patchSize = num(vc.patch_size) ?? num(vc.spatial_patch_size)
	const spec: VisionSpec = { modelType: mt, stack }
	if (imageSize) spec.imageSize = imageSize
	if (patchSize) spec.patchSize = patchSize
	if (imageSize && patchSize) spec.patches = Math.round(imageSize / patchSize) ** 2
	// qwen2-vl style vision configs name things differently
	const depth = num(vc.depth)
	if (depth) stack.layers = depth
	const embed = num(vc.embed_dim)
	if (embed && !num(vc.hidden_size)) stack.hidden = embed
	return spec
}

/** Normalizes a transformers config. Returns null when it does not look like one. */
export function analyzeConfig(raw: unknown): ArchSpec | null {
	if (!isObj(raw)) return null
	const cfg = raw
	const mt = (asStr(cfg.model_type) ?? '').toLowerCase()
	const architecture = asStr(asArr(cfg.architectures)[0])
	const assumed: string[] = []
	const tied = cfg.tie_word_embeddings !== false && (cfg.tie_word_embeddings === true || ENCODER_TYPES.has(mt) || mt === 'gpt2' || mt === 't5' || mt === 'whisper' || mt === 'bart' || mt === 'gemma' || mt === 'gemma2')
	const dtype = asStr(cfg.torch_dtype) ?? asStr(cfg.dtype)

	const textCfg = isObj(cfg.text_config) ? withDefaults({ ...cfg.text_config }, assumed, 'text_config') : null
	const visionCfg = isObj(cfg.vision_config) ? cfg.vision_config : null

	// Encoder-decoder
	if (ENC_DEC_TYPES.has(mt) || cfg.is_encoder_decoder === true || (num(cfg.encoder_layers) && num(cfg.decoder_layers))) {
		const c = withDefaults(cfg, assumed, 'config')
		const { encoder, decoder } = encDecStacks(c, mt)
		const audio = mt === 'whisper' || mt === 'speech_to_text' || num(c.num_mel_bins) !== undefined
		const spec: ArchSpec = {
			family: 'encoder-decoder',
			modelType: mt,
			architecture,
			vocab: pick(c, ['vocab_size']),
			maxPositions: pick(c, ['max_target_positions', 'max_position_embeddings', 'n_positions']),
			tied,
			dtype,
			input: audio ? 'audio' : 'tokens',
			encoder,
			decoder,
			assumed,
		}
		if (audio) spec.melBins = num(c.num_mel_bins) ?? 80
		return spec
	}

	// VLM: vision tower + language model
	if (visionCfg && (textCfg || pick(cfg, ['num_hidden_layers', 'hidden_size']) !== undefined)) {
		const text = textCfg ?? cfg
		const t = textStack(text, 'Decoder', true)
		const vision = visionOf(visionCfg, assumed)
		const pt = asStr(cfg.projector_type) ?? (asStr(cfg.projector_hidden_act) ? 'MLP' : mt.includes('qwen') ? 'patch merger' : 'linear')
		const spec: ArchSpec = {
			family: 'vlm',
			modelType: mt,
			architecture,
			vocab: num(cfg.vocab_size) ?? t.vocab,
			maxPositions: t.maxPos,
			tied: text.tie_word_embeddings === true || cfg.tie_word_embeddings === true,
			dtype,
			input: 'tokens',
			decoder: t.stack,
			vision,
			projector: { kind: pt, act: asStr(cfg.projector_hidden_act), from: num(visionCfg.out_hidden_size) ?? vision.stack.hidden, to: t.stack.hidden },
			assumed,
		}
		return spec
	}

	// Encoder-only
	const looksEncoder = ENCODER_TYPES.has(mt) || /For(MaskedLM|SequenceClassification|TokenClassification|QuestionAnswering|ImageClassification)$|^(Bert|Roberta|XLMRoberta|Deberta\w*|DistilBert|Electra|MPNet|ModernBert)Model$/.test(architecture ?? '')
	const c = withDefaults(textCfg ?? cfg, assumed, 'config')
	if (looksEncoder && !/CausalLM$/.test(architecture ?? '')) {
		const t = textStack(c, 'Encoder', false)
		return { family: 'encoder', modelType: mt, architecture, vocab: t.vocab, maxPositions: t.maxPos, tied, dtype, input: mt.startsWith('vit') || mt === 'dinov2' || mt === 'beit' ? 'image' : 'tokens', encoder: t.stack, assumed }
	}

	if (pick(c, ['hidden_size', 'd_model', 'n_embd', 'dim']) === undefined && pick(c, ['num_hidden_layers', 'n_layer', 'num_layers']) === undefined) return null
	const t = textStack(c, 'Decoder', true)
	return { family: 'decoder', modelType: mt, architecture, vocab: t.vocab, maxPositions: t.maxPos, tied: c.tie_word_embeddings === true || (c.tie_word_embeddings !== false && (mt === 'gpt2' || mt === 'gemma' || mt === 'gemma2')), dtype, input: 'tokens', decoder: t.stack, assumed }
}

/** Short summary for node labels: `qwen2 · 28 layers · d=3584 · GQA 28/4`. */
export function specSummary(s: ArchSpec): string {
	const st = s.decoder ?? s.encoder
	if (!st) return s.modelType
	const parts = [s.modelType || s.architecture || 'model']
	if (s.family === 'encoder-decoder' && s.encoder && s.decoder) parts.push(`${s.encoder.layers}+${s.decoder.layers} layers`)
	else parts.push(`${st.layers} layers`)
	parts.push(`d=${st.hidden}`)
	if (st.moe) parts.push(`MoE ${st.moe.experts}×top-${st.moe.topK}`)
	if (s.vision) parts.push('vision')
	return parts.join(' · ')
}
