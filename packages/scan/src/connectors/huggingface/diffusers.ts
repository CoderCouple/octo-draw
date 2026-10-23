/**
 * Diffusers `model_index.json` → pipeline page (prompt → tokenizers → text
 * encoders → unet/transformer ← scheduler, → vae → image), and a component
 * page for a diffusers component config (`unet/config.json`, ...). Pure.
 */

import { asArr, asStr, isObj, type Obj } from '../../util'
import { num, Page } from './graph'

export type ComponentRole = 'tokenizer' | 'text_encoder' | 'denoiser' | 'vae' | 'scheduler' | 'image_encoder' | 'safety' | 'feature_extractor' | 'controlnet' | 'other'

export interface PipelineComponent {
	name: string
	library: string
	cls: string
	role: ComponentRole
}

export interface PipelineSpec {
	cls: string
	version?: string
	components: PipelineComponent[]
	output: 'image' | 'video' | 'audio' | '3d'
	/** img2img / inpaint / controlnet pipelines take an image too. */
	imageInput: boolean
}

function roleOf(name: string, cls: string): ComponentRole {
	const n = name.toLowerCase()
	if (n.startsWith('tokenizer')) return 'tokenizer'
	if (n.startsWith('text_encoder')) return 'text_encoder'
	if (n === 'unet' || n.startsWith('transformer') || n === 'prior' || n === 'decoder' || n === 'unet_2' || /UNet|Transformer2D|DiT|Flux.*Transformer|SD3Transformer/.test(cls)) return 'denoiser'
	if (n === 'vae' || n === 'movq' || n === 'vqvae' || /Autoencoder|VQModel/.test(cls)) return 'vae'
	if (n.includes('scheduler')) return 'scheduler'
	if (n === 'image_encoder') return 'image_encoder'
	if (n === 'safety_checker') return 'safety'
	if (n === 'feature_extractor' || n.includes('processor')) return 'feature_extractor'
	if (n.includes('controlnet')) return 'controlnet'
	return 'other'
}

export function analyzeModelIndex(raw: unknown): PipelineSpec | null {
	if (!isObj(raw) || typeof raw._class_name !== 'string') return null
	const components: PipelineComponent[] = []
	for (const [name, v] of Object.entries(raw)) {
		if (name.startsWith('_')) continue
		const arr = asArr(v)
		if (arr.length !== 2 || typeof arr[1] !== 'string' || !arr[1]) continue
		const library = asStr(arr[0]) ?? ''
		components.push({ name, library, cls: arr[1], role: roleOf(name, arr[1]) })
	}
	const cls = raw._class_name
	const output = /Video|AnimateDiff|I2VGen|CogVideo|Mochi|LTX|Wan|Hunyuan.*Video/i.test(cls) ? 'video' : /Audio|Music|Stable.?Audio/i.test(cls) ? 'audio' : /Shap|3D/i.test(cls) ? '3d' : 'image'
	return { cls, version: asStr(raw._diffusers_version), components, output, imageInput: /Img2Img|Inpaint|ControlNet|InstructPix2Pix|ImageVariation|Image2Image|Refiner|I2V|Upscale/i.test(cls) }
}

const LIB_ICON: Record<string, string> = { transformers: 'huggingface', diffusers: 'huggingface' }

/** Pipeline page. `details` maps component name → short config summary. */
export function pipelinePage(spec: PipelineSpec, srcBase: string, name: string, details: Record<string, string> = {}): Page {
	const p = new Page(name, 'right')
	const src = (x: string) => `${srcBase}#${x}`
	const comp = (c: PipelineComponent, extra?: string) =>
		p.node(c.name.replace(/_/g, ' '), { label: `${c.name} · ${c.cls}${extra ? ` · ${extra}` : ''}`, icon: LIB_ICON[c.library], src: src(`${c.name}/`) })
	const prompt = p.node('Prompt', { shape: 'oval', label: spec.cls.includes('Audio') ? 'Text prompt' : 'Text prompt', src: src('pipeline.input') })
	const by = (r: ComponentRole) => spec.components.filter((c) => c.role === r)
	const toks = by('tokenizer')
	const encs = by('text_encoder')
	const denoisers = by('denoiser')
	const latent = p.node('Latents', { shape: 'oval', label: 'Random latents (noise)', src: src('pipeline.latents') })
	const den = denoisers.map((c) => comp(c, details[c.name]))
	const target = den[0]
	for (const e of encs) {
		const suffix = e.name.slice('text_encoder'.length)
		const tok = toks.find((t) => t.name.slice('tokenizer'.length) === suffix)
		const ek = comp(e, details[e.name])
		if (tok) {
			const tk = comp(tok)
			p.chain(prompt, tk, ek)
		} else p.edge(prompt, ek)
		if (target) p.edge(ek, target, 'text embeddings')
	}
	if (!encs.length && target) p.edge(prompt, target)
	if (target) p.edge(latent, target)
	for (let i = 1; i < den.length; i++) p.edge(den[i - 1], den[i])
	for (const s of by('scheduler')) {
		const sk = comp(s)
		if (target) p.edge(sk, target, 'timesteps / denoising loop', { dotted: true })
	}
	for (const c of [...by('image_encoder'), ...by('controlnet'), ...by('feature_extractor')]) {
		const ck = comp(c, details[c.name])
		if (target) p.edge(ck, target, c.role === 'controlnet' ? 'control residuals' : 'image embeddings')
	}
	if (spec.imageInput) {
		const img = p.node('Input image', { shape: 'oval', src: src('pipeline.image') })
		const vae = by('vae')[0]
		if (vae) p.edge(img, comp(vae), 'encode')
		else if (target) p.edge(img, target)
	}
	const outLabel = spec.output === 'video' ? 'Video frames' : spec.output === 'audio' ? 'Audio' : spec.output === '3d' ? '3D asset' : 'Image'
	const out = p.node('Output', { shape: 'oval', label: outLabel, src: src('pipeline.output') })
	const vae = by('vae')[0]
	const last = den[den.length - 1]
	if (vae) {
		const vk = comp(vae, details[vae.name])
		if (last) p.edge(last, vk, 'denoised latents')
		p.edge(vk, out, 'decode')
	} else if (last) p.edge(last, out)
	for (const s of by('safety')) {
		const sk = comp(s)
		p.edge(out, sk, 'check', { dotted: true })
	}
	for (const c of by('other')) comp(c)
	return p
}

/** One-line summary of a diffusers component config, for pipeline labels. */
export function componentSummary(cfg: Obj): string {
	const cls = asStr(cfg._class_name) ?? ''
	const bits: string[] = []
	const ch = asArr(cfg.block_out_channels).map(Number).filter(Number.isFinite)
	if (/UNet/.test(cls) && ch.length) bits.push(`channels ${ch.join('/')}`)
	const layers = Number(cfg.num_layers)
	if (Number.isFinite(layers) && layers) bits.push(`${layers}${cfg.num_single_layers ? ` + ${cfg.num_single_layers} single` : ''} blocks`)
	if (cfg.cross_attention_dim) bits.push(`cross-attn ${cfg.cross_attention_dim}`)
	if (cfg.latent_channels) bits.push(`${cfg.latent_channels} latent ch`)
	if (cfg.sample_size && !/Autoencoder/.test(cls)) bits.push(`latent ${cfg.sample_size}px`)
	if (cfg.model_type && cfg.hidden_size) bits.push(`${cfg.model_type} d=${cfg.hidden_size}${cfg.num_hidden_layers ? ` × ${cfg.num_hidden_layers}` : ''}`)
	return bits.join(', ')
}

/** Details page for a diffusers component (UNet down/mid/up blocks, transformer blocks, VAE). */
export function componentPage(componentName: string, cfg: Obj, srcBase: string, name: string): Page {
	const p = new Page(name, 'down')
	const src = (x: string) => `${srcBase}#${componentName}/${x}`
	const cls = asStr(cfg._class_name) ?? componentName
	const chans = asArr(cfg.block_out_channels).map(Number)
	const inCh = Number(cfg.in_channels) || undefined
	const input = p.node('Input', { shape: 'oval', label: `${cls} input${inCh ? ` · ${inCh} channels` : ''}`, src: src('input') })
	const out = p.node('Output', { shape: 'oval', label: `${cls} output${cfg.out_channels ? ` · ${cfg.out_channels} channels` : ''}`, src: src('output') })
	const downs = asArr(cfg.down_block_types).map((x) => String(x))
	const ups = asArr(cfg.up_block_types).map((x) => String(x))
	if (downs.length || ups.length) {
		let prev = input
		if (downs.length) {
			const g = p.group('Down blocks', { label: `Down blocks (encoder path)`, src: src('down_blocks') })
			let last = ''
			downs.forEach((t, i) => {
				const k = p.node(`Down ${i + 1}`, { label: `${t}${chans[i] ? ` · ${num(chans[i])} ch` : ''}`, parent: g, src: src(`down_blocks.${i}`) })
				if (last) p.edge(last, k)
				last = k
			})
			p.edge(prev, g)
			prev = g
		}
		const mid = asStr(cfg.mid_block_type) ?? (/UNet/.test(cls) ? 'UNetMidBlock2DCrossAttn' : undefined)
		if (mid) {
			const m = p.node('Mid block', { label: `${mid}${chans.length ? ` · ${num(chans[chans.length - 1])} ch` : ''}`, src: src('mid_block') })
			p.edge(prev, m)
			prev = m
		}
		if (ups.length) {
			const g = p.group('Up blocks', { label: 'Up blocks (decoder path)', src: src('up_blocks') })
			let last = ''
			const rev = [...chans].reverse()
			ups.forEach((t, i) => {
				const k = p.node(`Up ${i + 1}`, { label: `${t}${rev[i] ? ` · ${num(rev[i])} ch` : ''}`, parent: g, src: src(`up_blocks.${i}`) })
				if (last) p.edge(last, k)
				last = k
			})
			p.edge(prev, g)
			if (downs.length) p.edge('Down blocks', g, 'skip connections', { dotted: true })
			prev = g
		}
		p.edge(prev, out)
		if (cfg.cross_attention_dim) {
			const c = p.node('Conditioning', { shape: 'oval', label: `Text embeddings · ${cfg.cross_attention_dim}-d cross-attention`, src: src('conditioning') })
			p.edge(c, downs.length ? 'Down blocks' : prev, 'cross-attention', { dotted: true })
		}
		if (cfg.addition_embed_type) p.node('Added conditioning', { shape: 'document', label: `Added embeddings: ${cfg.addition_embed_type}${cfg.projection_class_embeddings_input_dim ? ` (${cfg.projection_class_embeddings_input_dim}-d)` : ''}`, src: src('added_cond') })
		return p
	}
	// transformer-style denoisers (DiT / MMDiT / Flux)
	const layers = Number(cfg.num_layers) || 0
	if (layers) {
		const dual = p.node('Blocks', { label: `${cls.includes('Flux') ? 'Double-stream (MMDiT) blocks' : 'Transformer blocks'} × ${layers}${cfg.num_attention_heads ? ` · ${cfg.num_attention_heads} heads` : ''}${cfg.attention_head_dim ? ` × ${cfg.attention_head_dim}` : ''}`, src: src('blocks') })
		p.chain(input, dual)
		let last = dual
		if (cfg.num_single_layers) {
			const single = p.node('Single blocks', { label: `Single-stream blocks × ${cfg.num_single_layers}`, src: src('single_blocks') })
			p.edge(dual, single)
			last = single
		}
		p.edge(last, out)
		if (cfg.joint_attention_dim) {
			const c = p.node('Conditioning', { shape: 'oval', label: `Text tokens · ${cfg.joint_attention_dim}-d (joint attention)`, src: src('conditioning') })
			p.edge(c, dual)
		}
		return p
	}
	// anything else: config facts as a note
	const facts = Object.entries(cfg)
		.filter(([k, v]) => !k.startsWith('_') && (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean'))
		.slice(0, 12)
		.map(([k, v]) => `${k}=${v}`)
	const note = p.node('Config', { shape: 'document', label: `${cls}: ${facts.join(', ')}`, src: src('config') })
	p.chain(input, note, out)
	return p
}
