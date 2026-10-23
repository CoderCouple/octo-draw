/**
 * ArchSpec → pages. Every node carries `src: "<base>#<path>"`; the paths are
 * what `expandArch` (and the `huggingface` expander) accept:
 *
 *   architecture            the whole network (the "Architecture" page)
 *   decoder | encoder | vision          one block of that stack
 *   <stack>.attn | <stack>.cross        attention internals (Q/K/V, RoPE, SDPA, O)
 *   <stack>.mlp                         MLP internals, or the MoE router + experts
 *   <stack>.expert                      one expert MLP (MoE)
 *   anything else                       a small details page (facts about that part)
 */

import type { ArchSpec, AttnSpec, StackSpec } from './config'
import { humanCount, num, Page } from './graph'
import { estimateParams, layerParams } from './params'

export interface ArchContext {
	/** `hf:org/name` (plus `@rev`), the prefix of every `src`. */
	srcBase: string
	/** Path prefix for a component in a subfolder (`text_encoder/`). */
	prefix?: string
	/** Exact parameter count from safetensors metadata, if known. */
	params?: number
}

const ACT: Record<string, string> = { silu: 'SiLU', swish: 'SiLU', gelu: 'GELU', gelu_new: 'GELU', gelu_pytorch_tanh: 'GELU (tanh)', quick_gelu: 'QuickGELU', relu: 'ReLU', gelu_fast: 'GELU' }
const actName = (a: string) => ACT[a] ?? a
const mlpName = (s: StackSpec) => (s.mlp.gated ? (s.mlp.act === 'silu' || s.mlp.act === 'swish' ? 'SwiGLU' : `Gated ${actName(s.mlp.act)}`) : actName(s.mlp.act)) + ' MLP'
const sci = (n: number) => (n >= 1e5 && /^10*$/.test(String(n)) ? `1e${String(n).length - 1}` : num(n))

function attnTitle(a: AttnSpec, cross = false): string {
	const kind = cross ? 'Cross-attention' : 'Self-attention'
	const heads = a.variant === 'MHA' ? `${a.heads} heads` : a.variant === 'MLA' ? `MLA ${a.heads} heads` : `${a.variant} ${a.heads} heads / ${a.kvHeads} KV`
	const bits = [kind, heads, `head dim ${a.headDim}`]
	if (!cross && a.pos === 'rope') bits.push(`RoPE θ=${sci(a.ropeTheta ?? 10000)}`)
	if (!cross && a.slidingWindow) bits.push(`window ${num(a.slidingWindow)}`)
	return bits.join(' · ')
}

function mlpTitle(s: StackSpec): string {
	if (s.moe) {
		const ei = s.moe.expertIntermediate ?? s.mlp.intermediate
		return `MoE · ${s.moe.experts} experts, top-${s.moe.topK}${s.moe.shared ? ` + ${s.moe.shared} shared` : ''} · ${num(s.hidden)} → ${num(ei)}`
	}
	return `${mlpName(s)} · ${num(s.hidden)} → ${num(s.mlp.intermediate)}`
}

/** Stable path prefix for a stack. */
const stackPath = (s: StackSpec) => (s.name === 'Vision encoder' ? 'vision' : s.name.toLowerCase())

function stackOf(spec: ArchSpec, path: string): StackSpec | undefined {
	if (path === 'vision') return spec.vision?.stack
	if (path === 'encoder') return spec.encoder
	if (path === 'decoder') return spec.decoder
	return undefined
}

/** A stack drawn as one group "Decoder × 32 layers" holding its sublayers. */
function stackGroup(p: Page, spec: ArchSpec, s: StackSpec, ctx: ArchContext, title?: string): { group: string; attn: string; cross?: string; mlp: string } {
	const sp = stackPath(s)
	const prefix = s.name === 'Decoder' && spec.family !== 'encoder-decoder' ? '' : `${s.name} `
	const label = `${title ?? s.name} × ${s.layers} layers`
	const group = p.group(s.name, { label, src: `${ctx.srcBase}#${ctx.prefix ?? ''}${sp}` })
	const attn = p.node(`${prefix}self-attention`.replace(/^s/, 'S'), { label: attnTitle(s.attn), parent: group, src: `${ctx.srcBase}#${ctx.prefix ?? ''}${sp}.attn` })
	let cross: string | undefined
	if (s.cross) cross = p.node('Cross-attention', { label: attnTitle(s.attn, true), parent: group, src: `${ctx.srcBase}#${ctx.prefix ?? ''}${sp}.cross` })
	const mlp = p.node(`${prefix}${s.moe ? 'MoE' : 'MLP'}`, { label: mlpTitle(s), parent: group, src: `${ctx.srcBase}#${ctx.prefix ?? ''}${sp}.mlp` })
	p.chain(attn, ...(cross ? [cross] : []), mlp)
	return { group, attn, cross, mlp }
}

/** The "Architecture" page. */
export function architecturePage(spec: ArchSpec, ctx: ArchContext, name = 'Architecture'): Page {
	const p = new Page(name, 'down')
	const s = (path: string) => `${ctx.srcBase}#${ctx.prefix ?? ''}${path}`
	const est = estimateParams(spec)
	const total = ctx.params ?? est.total
	const main = spec.decoder ?? spec.encoder
	if (!main) return p
	const embLabel = `Token embeddings · ${spec.vocab ? num(spec.vocab) : '?'} × ${num(main.hidden)}`

	if (spec.family === 'encoder-decoder' && spec.encoder && spec.decoder) {
		let encIn: string
		if (spec.input === 'audio') {
			const audio = p.node('Audio', { shape: 'oval', label: `Audio → log-mel spectrogram · ${spec.melBins ?? 80} bins`, src: s('input') })
			const conv = p.node('Conv stem', { label: `2 × Conv1d + GELU · ${spec.melBins ?? 80} → ${num(spec.encoder.hidden)}`, src: s('conv') })
			const pos = p.node('Positional embeddings', { label: `${spec.encoder.attn.pos === 'sinusoidal' ? 'Sinusoidal' : 'Learned'} positions`, src: s('positions') })
			p.chain(audio, conv, pos)
			encIn = pos
		} else {
			const tokens = p.node('Input tokens', { shape: 'oval', src: s('input') })
			const emb = p.node('Shared embeddings', { label: embLabel + (spec.encoder.attn.pos === 'relative' ? ' · relative position bias' : ''), src: s('embeddings') })
			p.chain(tokens, emb)
			encIn = emb
		}
		const enc = stackGroup(p, spec, spec.encoder, ctx)
		const encNorm = p.node('Encoder final norm', { label: `Encoder final ${spec.encoder.norm}`, src: s('encoder.norm') })
		p.chain(encIn, enc.group, encNorm)
		const prev = p.node('Previous tokens', { shape: 'oval', label: 'Decoder input (previous tokens)', src: s('decoder.input') })
		const decEmb = spec.input === 'audio' ? p.node('Decoder embeddings', { label: embLabel, src: s('embeddings') }) : 'Shared embeddings'
		p.chain(prev, decEmb)
		const dec = stackGroup(p, spec, spec.decoder, ctx)
		p.edge(decEmb, dec.group)
		p.edge(encNorm, dec.cross ?? dec.group, 'keys / values')
		const norm = p.node('Final norm', { label: `Decoder final ${spec.decoder.norm}`, src: s('decoder.norm') })
		const head = p.node('LM head', { label: `LM head · ${num(spec.decoder.hidden)} → ${spec.vocab ? num(spec.vocab) : '?'}${spec.tied ? ' (tied)' : ''}`, src: s('lm_head') })
		const out = p.node('Output', { shape: 'oval', label: spec.input === 'audio' ? 'Transcript tokens' : 'Output tokens', src: s('output') })
		p.chain(dec.group, norm, head, out)
		p.node('Parameters', { shape: 'document', label: paramLabel(total, ctx.params === undefined, est.active), src: s('params') })
		return p
	}

	if (spec.family === 'encoder' && spec.encoder) {
		const tokens = p.node('Input', { shape: 'oval', label: spec.input === 'image' ? 'Image patches' : 'Input tokens', src: s('input') })
		const emb = p.node('Embeddings', { label: spec.input === 'image' ? `Patch embeddings · d=${num(main.hidden)}` : `${embLabel} + ${spec.encoder.attn.pos === 'rope' ? 'RoPE' : 'positions'}`, src: s('embeddings') })
		const enc = stackGroup(p, spec, spec.encoder, ctx)
		const arch = spec.architecture ?? ''
		const headKind = /MaskedLM/.test(arch) ? 'Masked-LM head' : /SequenceClassification/.test(arch) ? 'Classification head' : /TokenClassification/.test(arch) ? 'Token classification head' : /QuestionAnswering/.test(arch) ? 'Span (QA) head' : 'Pooler'
		const head = p.node('Head', { label: headKind, src: s('head') })
		const out = p.node('Output', { shape: 'oval', label: headKind === 'Pooler' ? 'Embeddings / features' : 'Predictions', src: s('output') })
		p.chain(tokens, emb, enc.group, head, out)
		p.node('Parameters', { shape: 'document', label: paramLabel(total, ctx.params === undefined), src: s('params') })
		return p
	}

	// decoder-only, optionally with a vision tower (VLM)
	const tokens = p.node('Input tokens', { shape: 'oval', src: s('input') })
	const emb = p.node('Embeddings', { label: embLabel, src: s('embeddings') })
	p.chain(tokens, emb)
	let into = emb
	if (spec.vision && spec.decoder) {
		const v = spec.vision
		const img = p.node('Image', { shape: 'oval', label: v.imageSize ? `Image ${v.imageSize}×${v.imageSize}` : 'Image', src: s('vision.input') })
		const patch = p.node('Patch embedding', { label: v.patchSize ? `Patch embedding · ${v.patchSize}×${v.patchSize}${v.patches ? ` → ${num(v.patches)} patches` : ''}` : 'Patch embedding', src: s('vision.patch') })
		const vg = stackGroup(p, spec, v.stack, ctx, visionTitle(v.modelType))
		const proj = p.node('Projector', { label: `${spec.projector?.kind ?? 'Linear'} projector${spec.projector?.act ? ` (${actName(spec.projector.act)})` : ''} · ${num(spec.projector?.from ?? v.stack.hidden)} → ${num(spec.decoder.hidden)}`, src: s('projector') })
		const merge = p.node('Merge', { label: 'Image tokens + text tokens', src: s('merge') })
		p.chain(img, patch, vg.group, proj, merge)
		p.edge(emb, merge)
		into = merge
	}
	const dec = stackGroup(p, spec, spec.decoder!, ctx)
	p.edge(into, dec.group)
	const norm = p.node('Final norm', { label: `Final ${spec.decoder!.norm}`, src: s('decoder.norm') })
	const head = p.node('LM head', { label: `LM head · ${num(spec.decoder!.hidden)} → ${spec.vocab ? num(spec.vocab) : '?'}${spec.tied ? ' (tied to embeddings)' : ''}`, src: s('lm_head') })
	const out = p.node('Logits', { shape: 'oval', label: 'Next-token logits', src: s('output') })
	p.chain(dec.group, norm, head, out)
	p.node('Parameters', { shape: 'document', label: paramLabel(total, ctx.params === undefined, est.active), src: s('params') })
	return p
}

function visionTitle(mt: string): string {
	if (mt.includes('clip')) return 'CLIP ViT'
	if (mt.includes('siglip')) return 'SigLIP ViT'
	if (mt.includes('qwen')) return 'Qwen ViT'
	return 'Vision encoder'
}

function paramLabel(total: number, estimated: boolean, active?: number): string {
	return `${estimated ? '≈ ' : ''}${humanCount(total)} parameters${estimated ? ' (estimated from config)' : ''}${active ? ` · ≈ ${humanCount(active)} active per token` : ''}`
}

/** One block of a stack (`decoder`, `encoder`, `vision`). */
export function blockPage(spec: ArchSpec, s: StackSpec, ctx: ArchContext, name: string): Page {
	const p = new Page(name, 'down')
	const sp = stackPath(s)
	const src = (path: string) => `${ctx.srcBase}#${ctx.prefix ?? ''}${sp}.${path}`
	const lp = layerParams(s)
	const input = p.node('Block input', { shape: 'oval', label: `Hidden states · d=${num(s.hidden)}`, src: src('input') })
	const norm = (k: string) => p.node(k, { label: `${s.norm}${s.normEps ? ` (eps ${s.normEps < 1e-3 ? s.normEps.toExponential() : s.normEps})` : ''}`, src: src(k.toLowerCase().replace(/\s+/g, '_')) })
	const add = (k: string) => p.node(k, { shape: 'ellipse', label: '+ residual', src: src('residual') })
	const attn = p.node(s.causal ? 'Causal self-attention' : 'Self-attention', { label: attnTitle(s.attn), src: src('attn') })
	const mlp = p.node(s.moe ? 'MoE' : 'MLP', { label: mlpTitle(s), src: src('mlp') })
	const out = p.node('Block output', { shape: 'oval', label: `Hidden states · d=${num(s.hidden)}`, src: src('output') })
	const add1 = add('Add 1')
	let last: string
	if (s.postNorm) {
		const n1 = norm('Norm 1')
		p.chain(input, attn, add1, n1)
		p.edge(input, add1, 'residual', { dotted: true })
		last = n1
	} else {
		const n1 = norm('Pre-attention norm')
		p.chain(input, n1, attn, add1)
		p.edge(input, add1, 'residual', { dotted: true })
		last = add1
	}
	if (s.cross) {
		const cross = p.node('Cross-attention', { label: attnTitle(s.attn, true), src: src('cross') })
		const enc = p.node('Encoder output', { shape: 'oval', src: `${ctx.srcBase}#${ctx.prefix ?? ''}encoder` })
		const addC = add('Add 2')
		if (s.postNorm) {
			const nC = norm('Norm 2')
			p.chain(last, cross, addC, nC)
			p.edge(last, addC, 'residual', { dotted: true })
			last = nC
		} else {
			const nC = norm('Pre-cross norm')
			p.chain(last, nC, cross, addC)
			p.edge(last, addC, 'residual', { dotted: true })
			last = addC
		}
		p.edge(enc, cross, 'keys / values')
	}
	const addM = add(s.cross ? 'Add 3' : 'Add 2')
	if (s.postNorm) {
		const nM = norm(s.cross ? 'Norm 3' : 'Norm 2')
		p.chain(last, mlp, addM, nM)
		p.edge(last, addM, 'residual', { dotted: true })
		p.edge(nM, out)
	} else {
		const nM = norm('Pre-MLP norm')
		p.chain(last, nM, mlp, addM)
		p.edge(last, addM, 'residual', { dotted: true })
		p.edge(addM, out)
	}
	p.node('Block parameters', { shape: 'document', label: `≈ ${humanCount(lp.total)} parameters per layer${lp.active !== lp.total ? ` · ≈ ${humanCount(lp.active)} active` : ''} · × ${s.layers}`, src: src('params') })
	void spec
	return p
}

/** Attention internals. */
export function attentionPage(s: StackSpec, ctx: ArchContext, name: string, cross = false): Page {
	const p = new Page(name, 'down')
	const sp = stackPath(s)
	const src = (path: string) => `${ctx.srcBase}#${ctx.prefix ?? ''}${sp}.${cross ? 'cross' : 'attn'}.${path}`
	const a = s.attn
	const d = num(s.hidden)
	const input = p.node('Input', { shape: 'oval', label: cross ? `Decoder hidden states · d=${d}` : `Normed hidden states · d=${d}`, src: src('input') })
	const kvSource = cross ? p.node('Encoder output', { shape: 'oval', label: `Encoder output · d=${d}`, src: `${ctx.srcBase}#${ctx.prefix ?? ''}encoder` }) : input
	const q = p.node('Q proj', { label: `Q proj · ${d} → ${a.heads} × ${a.headDim}${a.bias ? ' (+bias)' : ''}`, src: src('q_proj') })
	let k: string
	let v: string
	if (a.kvLoraRank) {
		const down = p.node('KV down-proj', { label: `KV down-proj · ${d} → latent ${num(a.kvLoraRank)}`, src: src('kv_a_proj') })
		k = p.node('K up-proj', { label: `K up-proj · ${num(a.kvLoraRank)} → ${a.heads} × ${a.headDim}`, src: src('k_proj') })
		v = p.node('V up-proj', { label: `V up-proj · ${num(a.kvLoraRank)} → ${a.heads} × ${a.headDim}`, src: src('v_proj') })
		p.edge(kvSource, down)
		p.edge(down, k)
		p.edge(down, v)
	} else {
		k = p.node('K proj', { label: `K proj · ${d} → ${a.kvHeads} × ${a.headDim}`, src: src('k_proj') })
		v = p.node('V proj', { label: `V proj · ${d} → ${a.kvHeads} × ${a.headDim}`, src: src('v_proj') })
		p.edge(kvSource, k)
		p.edge(kvSource, v)
	}
	p.edge(input, q)
	const groups = a.kvHeads && a.heads % a.kvHeads === 0 ? a.heads / a.kvHeads : 0
	const sdpaBits = ['Scaled dot-product attention', s.causal && !cross ? 'causal mask' : cross ? 'no mask' : 'bidirectional', `${a.heads} heads`]
	if (a.variant === 'GQA' && groups > 1) sdpaBits.push(`${groups} query heads per KV head`)
	if (a.variant === 'MQA') sdpaBits.push('1 shared KV head')
	if (!cross && a.slidingWindow) sdpaBits.push(`sliding window ${num(a.slidingWindow)}`)
	if (!cross && a.pos === 'alibi') sdpaBits.push('ALiBi bias')
	if (!cross && a.pos === 'relative') sdpaBits.push('relative position bias')
	const sdpa = p.node('SDPA', { label: sdpaBits.join(' · '), src: src('sdpa') })
	if (!cross && a.pos === 'rope') {
		const rope = p.node('RoPE', { label: `RoPE on Q and K · θ=${sci(a.ropeTheta ?? 10000)}${a.ropeScaling ? ` · ${a.ropeScaling} scaling` : ''}`, src: src('rope') })
		p.edge(q, rope)
		p.edge(k, rope)
		p.edge(rope, sdpa, 'Q, K')
	} else {
		p.edge(q, sdpa)
		p.edge(k, sdpa)
	}
	p.edge(v, sdpa)
	if (s.causal && !cross) {
		const cache = p.node('KV cache', { shape: 'cylinder', label: `KV cache · ${a.kvLoraRank ? `latent ${num(a.kvLoraRank)}` : `${a.kvHeads} × ${a.headDim}`} per token per layer`, src: src('kv_cache') })
		p.edge(k, cache, undefined, { dotted: true })
		p.edge(v, cache, undefined, { dotted: true })
	}
	const o = p.node('O proj', { label: `O proj · ${a.heads} × ${a.headDim} → ${d}`, src: src('o_proj') })
	const out = p.node('Output', { shape: 'oval', label: `Attention output · d=${d}`, src: src('output') })
	p.chain(sdpa, o, out)
	return p
}

/** Dense MLP internals (also one MoE expert). */
export function mlpPage(s: StackSpec, ctx: ArchContext, name: string, intermediate = s.mlp.intermediate, path = 'mlp'): Page {
	const p = new Page(name, 'down')
	const src = (x: string) => `${ctx.srcBase}#${ctx.prefix ?? ''}${stackPath(s)}.${path}.${x}`
	const d = num(s.hidden)
	const i = num(intermediate)
	const input = p.node('Input', { shape: 'oval', label: `Normed hidden states · d=${d}`, src: src('input') })
	const out = p.node('Output', { shape: 'oval', label: `MLP output · d=${d}`, src: src('output') })
	const act = p.node('Activation', { label: actName(s.mlp.act), src: src('act') })
	const down = p.node('Down proj', { label: `Down proj · ${i} → ${d}`, src: src('down_proj') })
	if (s.mlp.gated) {
		const gate = p.node('Gate proj', { label: `Gate proj · ${d} → ${i}`, src: src('gate_proj') })
		const up = p.node('Up proj', { label: `Up proj · ${d} → ${i}`, src: src('up_proj') })
		const mul = p.node('Multiply', { shape: 'ellipse', label: '× elementwise', src: src('mul') })
		p.edge(input, gate)
		p.edge(input, up)
		p.chain(gate, act, mul)
		p.edge(up, mul)
		p.chain(mul, down, out)
	} else {
		const up = p.node('Up proj', { label: `Up proj (fc1) · ${d} → ${i}`, src: src('up_proj') })
		p.chain(input, up, act, down, out)
	}
	return p
}

/** MoE: router, experts (a few drawn, the rest folded), optional shared experts. */
export function moePage(s: StackSpec, ctx: ArchContext, name: string): Page {
	const p = new Page(name, 'down')
	const moe = s.moe!
	const src = (x: string) => `${ctx.srcBase}#${ctx.prefix ?? ''}${stackPath(s)}.mlp.${x}`
	const d = num(s.hidden)
	const ei = moe.expertIntermediate ?? s.mlp.intermediate
	const input = p.node('Input', { shape: 'oval', label: `Normed hidden states · d=${d}`, src: src('input') })
	const router = p.node('Router', { label: `Router · linear ${d} → ${moe.experts} · softmax · top-${moe.topK}`, src: src('router') })
	const group = p.group('Experts', { label: `${moe.experts} experts (${moe.topK} active per token)`, src: `${ctx.srcBase}#${ctx.prefix ?? ''}${stackPath(s)}.expert` })
	const shown = Math.min(moe.experts, 3)
	for (let e = 1; e <= shown; e++) p.node(`Expert ${e}`, { label: `Expert ${e} · ${mlpName(s)} ${d} → ${num(ei)}`, parent: group, src: `${ctx.srcBase}#${ctx.prefix ?? ''}${stackPath(s)}.expert` })
	if (moe.experts > shown) p.node('More experts', { label: `… ${moe.experts - shown} more`, parent: group, src: `${ctx.srcBase}#${ctx.prefix ?? ''}${stackPath(s)}.expert` })
	const combine = p.node('Combine', { shape: 'ellipse', label: 'Weighted sum of top-k outputs', src: src('combine') })
	const out = p.node('Output', { shape: 'oval', label: `MoE output · d=${d}`, src: src('output') })
	p.edge(input, router)
	p.edge(router, group, `top-${moe.topK} routing weights`)
	p.edge(input, group, 'tokens')
	p.edge(group, combine)
	if (moe.shared) {
		const sh = p.node('Shared experts', { label: `${moe.shared} shared expert${moe.shared > 1 ? 's' : ''} (always on)`, src: `${ctx.srcBase}#${ctx.prefix ?? ''}${stackPath(s)}.expert` })
		p.edge(input, sh)
		p.edge(sh, combine)
	}
	if (moe.denseLayers) p.node('Dense layers', { shape: 'document', label: `First ${moe.denseLayers} layers use a dense MLP instead`, src: src('dense') })
	p.chain(combine, out)
	return p
}

/** Details page for any other part: what we know about it, as a note. */
function detailsPage(spec: ArchSpec, ctx: ArchContext, path: string, name: string): Page {
	const p = new Page(name, 'down')
	const facts: string[] = [`${spec.architecture ?? spec.modelType}`, `part: ${path}`]
	const st = stackOf(spec, path.split('.')[0])
	if (st) facts.push(`hidden ${num(st.hidden)}`, `${st.layers} layers`, `norm ${st.norm}`)
	if (path === 'embeddings' && spec.vocab) facts.push(`vocab ${num(spec.vocab)}`, spec.maxPositions ? `max positions ${num(spec.maxPositions)}` : '')
	if (path === 'params') {
		const e = estimateParams(spec)
		facts.push(`embeddings ≈ ${humanCount(e.embeddings)}`, `per layer ≈ ${humanCount(e.perLayer)}`, `LM head ≈ ${humanCount(e.head)}`, e.vision ? `vision ≈ ${humanCount(e.vision)}` : '')
	}
	if (spec.dtype) facts.push(`dtype ${spec.dtype}`)
	p.node(path, { shape: 'document', label: facts.filter(Boolean).join(' · '), src: `${ctx.srcBase}#${ctx.prefix ?? ''}${path}` })
	return p
}

/** Page for an architecture path (see the module comment). Null when the path does not apply. */
export function expandArch(spec: ArchSpec, path: string, ctx: ArchContext, name: string): Page | null {
	if (path === '' || path === 'architecture') return architecturePage(spec, ctx, name)
	const [head, sub] = path.split('.')
	const st = stackOf(spec, head)
	if (st && sub === undefined) return blockPage(spec, st, ctx, name)
	if (st && sub === 'attn' && path.split('.').length === 2) return attentionPage(st, ctx, name)
	if (st && sub === 'cross' && st.cross && path.split('.').length === 2) return attentionPage(st, ctx, name, true)
	if (st && sub === 'mlp' && path.split('.').length === 2) return st.moe ? moePage(st, ctx, name) : mlpPage(st, ctx, name)
	if (st && sub === 'expert' && st.moe) return mlpPage(st, ctx, name, st.moe.expertIntermediate ?? st.mlp.intermediate, 'expert')
	return detailsPage(spec, ctx, path, name)
}

/** Paths worth a page of their own when pre-generating deeper levels. */
export function isStructural(path: string): boolean {
	return /^(architecture|decoder|encoder|vision)(\.(attn|cross|mlp|expert))?$/.test(path)
}
