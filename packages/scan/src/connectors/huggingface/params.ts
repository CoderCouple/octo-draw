/**
 * Parameter estimates from an ArchSpec (weights only; biases and norms are
 * tiny and mostly ignored). Used when the Hub has no safetensors metadata.
 */

import type { ArchSpec, StackSpec } from './config'

export interface ParamBreakdown {
	embeddings: number
	perLayer: number
	layers: number
	head: number
	vision: number
	total: number
	/** Parameters touched per token (MoE). */
	active?: number
}

function attnParams(s: StackSpec): number {
	const { heads, kvHeads, headDim, kvLoraRank } = s.attn
	const q = s.hidden * heads * headDim
	const o = heads * headDim * s.hidden
	if (kvLoraRank) return q + o + s.hidden * kvLoraRank + kvLoraRank * heads * headDim * 2
	return q + o + 2 * s.hidden * kvHeads * headDim
}

function mlpParams(hidden: number, intermediate: number, gated: boolean): number {
	return (gated ? 3 : 2) * hidden * intermediate
}

/** Weights of one layer and the per-token active part (they differ for MoE). */
export function layerParams(s: StackSpec): { total: number; active: number } {
	const attn = attnParams(s) * (s.cross ? 2 : 1)
	const norms = (s.cross ? 3 : 2) * s.hidden
	if (!s.moe) {
		const mlp = mlpParams(s.hidden, s.mlp.intermediate, s.mlp.gated)
		return { total: attn + mlp + norms, active: attn + mlp + norms }
	}
	const ei = s.moe.expertIntermediate ?? s.mlp.intermediate
	const expert = mlpParams(s.hidden, ei, s.mlp.gated)
	const router = s.hidden * s.moe.experts
	const shared = (s.moe.shared ?? 0) * expert
	return { total: attn + norms + router + shared + s.moe.experts * expert, active: attn + norms + router + shared + s.moe.topK * expert }
}

function stackParams(s: StackSpec): { total: number; active: number } {
	const l = layerParams(s)
	if (s.moe?.denseLayers) {
		const dense = attnParams(s) + mlpParams(s.hidden, s.mlp.intermediate, s.mlp.gated) + 2 * s.hidden
		const moeLayers = Math.max(0, s.layers - s.moe.denseLayers)
		return { total: dense * s.moe.denseLayers + l.total * moeLayers, active: dense * s.moe.denseLayers + l.active * moeLayers }
	}
	return { total: l.total * s.layers, active: l.active * s.layers }
}

export function estimateParams(spec: ArchSpec): ParamBreakdown {
	const main = spec.decoder ?? spec.encoder
	const hidden = main?.hidden ?? 0
	const vocab = spec.vocab ?? 0
	const embeddings = vocab * hidden
	let total = embeddings
	let active = embeddings
	let perLayer = 0
	let layers = 0
	for (const s of [spec.encoder, spec.decoder]) {
		if (!s) continue
		const p = stackParams(s)
		total += p.total
		active += p.active
		perLayer = Math.max(perLayer, layerParams(s).total)
		layers += s.layers
	}
	if (spec.input === 'audio' && spec.melBins && spec.encoder) {
		const conv = spec.melBins * hidden * 3 + hidden * hidden * 3
		total += conv
		active += conv
	}
	if (spec.family === 'encoder-decoder' && spec.maxPositions && spec.input === 'audio') {
		const pos = spec.maxPositions * hidden
		total += pos
		active += pos
	}
	const head = spec.tied || spec.family === 'encoder' ? 0 : vocab * hidden
	total += head
	active += head
	let vision = 0
	if (spec.vision) {
		const v = spec.vision
		vision = stackParams(v.stack).total + (v.patchSize ? 3 * v.patchSize * v.patchSize * v.stack.hidden : 0)
		if (spec.projector) vision += spec.projector.kind === 'MLP' ? spec.projector.from * spec.projector.to + spec.projector.to * spec.projector.to : spec.projector.from * spec.projector.to
		total += vision
		active += vision
	}
	const out: ParamBreakdown = { embeddings, perLayer, layers, head, vision, total }
	if (active !== total) out.active = active
	return out
}
