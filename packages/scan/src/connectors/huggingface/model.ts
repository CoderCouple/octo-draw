/**
 * Model repos: root page (model, lineage, datasets, license, task, library,
 * weights) plus one level: "Architecture" from config.json, or "Pipeline"
 * from a diffusers model_index.json. GGUF and adapter-only repos get a note.
 */

import { asArr, asObj, asStr, type Obj } from '../../util'
import { architecturePage, expandArch, isStructural } from './arch'
import { baseModels, cardOf, datasetsOf, licenseOf, type BaseModel, type BaseRelation } from './card'
import { jsonFile, type HfClient } from './client'
import { analyzeConfig, specSummary, type ArchSpec } from './config'
import { deepen } from './deepen'
import { analyzeModelIndex, componentSummary, pipelinePage, type PipelineSpec } from './diffusers'
import { humanBytes, humanCount, icon, Page, shortName } from './graph'
import { hfUrl } from './parse'
import { estimateParams } from './params'

export interface ModelMeta {
	id: string
	pipeline_tag?: string
	library_name?: string
	tags?: string[]
	cardData?: unknown
	config?: unknown
	siblings?: { rfilename: string; size?: number }[]
	safetensors?: { total?: number; parameters?: Record<string, number> }
	gguf?: { total?: number; architecture?: string; context_length?: number }
	gated?: false | 'auto' | 'manual' | boolean
	private?: boolean
	downloads?: number
	likes?: number
	spaces?: string[]
	usedStorage?: number
	sha?: string
	transformersInfo?: { auto_model?: string; pipeline_tag?: string }
}

export interface LineageNode {
	id: string
	/** How `child` derives from this model. */
	relation: BaseRelation
	child: string
	meta?: ModelMeta | null
}

export interface ModelFacts {
	meta: ModelMeta
	lineage: LineageNode[]
	spec?: ArchSpec | null
	pipeline?: PipelineSpec | null
	pipelineDetails?: Record<string, string>
	adapter?: Obj | null
	/** config.json exists but could not be read because the repo is gated. */
	configGated?: boolean
	warnings: string[]
}

const files = (m: ModelMeta) => (m.siblings ?? []).map((s) => s.rfilename)

/** Library → icon candidates. */
const LIB_ICONS: Record<string, string[]> = {
	transformers: ['huggingface'],
	diffusers: ['huggingface'],
	'sentence-transformers': ['huggingface'],
	peft: ['huggingface'],
	timm: ['pytorch'],
	pytorch: ['pytorch'],
	keras: ['tensorflow'],
	'tf-keras': ['tensorflow'],
	tensorflow: ['tensorflow'],
	gguf: ['cpu'],
	'llama.cpp': ['cpu'],
	mlx: ['apple'],
	'mlx-lm': ['apple'],
	vllm: ['server'],
	onnx: ['package'],
	'transformers.js': ['javascript'],
	'open_clip': ['pytorch'],
	'stable-baselines3': ['pytorch'],
	spacy: ['python'],
	nemo: ['pytorch'],
	ollama: ['ollama'],
}

/** Pipeline tag → icon candidates. */
export function taskIcon(task: string | undefined): string | undefined {
	if (!task) return undefined
	const t = task.toLowerCase()
	const c = t.includes('text-generation') || t.includes('text2text') || t === 'conversational' ? ['llm', 'chat'] : t.includes('image') || t.includes('vision') || t.includes('depth') || t.includes('segmentation') || t.includes('object-detection') ? ['image', 'eye', 'camera', 'ai'] : t.includes('speech') || t.includes('audio') ? ['mic', 'audio-lines', 'ai'] : t.includes('video') ? ['video', 'ai'] : t.includes('embedding') || t.includes('similarity') || t.includes('feature') ? ['search', 'ai'] : t.includes('classification') ? ['tag', 'ai'] : ['ai']
	return icon(...c) ?? undefined
}

export function libraryIcon(lib: string | undefined): string | undefined {
	if (!lib) return undefined
	return icon(...(LIB_ICONS[lib.toLowerCase()] ?? []), lib.toLowerCase(), 'package') ?? undefined
}

const REL_LABEL: Record<BaseRelation, string> = { finetune: 'fine-tuned into', adapter: 'adapter', quantized: 'quantized to', merge: 'merged into', base: 'base of' }

/** Walks `base_model` up to `depth` levels (breadth-first, at most `max` models). */
export async function walkLineage(hf: HfClient, meta: ModelMeta, depth: number, max = 12): Promise<LineageNode[]> {
	const out: LineageNode[] = []
	const seen = new Set<string>([meta.id.toLowerCase()])
	let frontier: { id: string; bases: BaseModel[] }[] = [{ id: meta.id, bases: baseModels(cardOf(meta), meta.tags ?? []) }]
	for (let level = 0; level < depth && frontier.length; level++) {
		const next: typeof frontier = []
		for (const f of frontier) {
			for (const b of f.bases) {
				if (seen.has(b.id.toLowerCase()) || out.length >= max) continue
				seen.add(b.id.toLowerCase())
				const node: LineageNode = { id: b.id, relation: b.relation, child: f.id }
				out.push(node)
				if (level + 1 < depth) {
					node.meta = await hf.tryApi<ModelMeta>(`/api/models/${b.id.split('/').map(encodeURIComponent).join('/')}`)
					if (node.meta) next.push({ id: b.id, bases: baseModels(cardOf(node.meta), node.meta.tags ?? []) })
				}
			}
		}
		frontier = next
	}
	return out
}

/** Reads everything the diagram needs. */
export async function collectModel(hf: HfClient, id: string, rev: string | undefined, lineageDepth: number): Promise<ModelFacts> {
	const meta = await hf.repo<ModelMeta>('model', id, rev)
	const warnings: string[] = []
	const fs = files(meta)
	const r = rev ?? 'main'
	const facts: ModelFacts = { meta, lineage: [], warnings }
	try {
		facts.lineage = await walkLineage(hf, meta, lineageDepth)
	} catch (err) {
		warnings.push(`lineage: ${err instanceof Error ? err.message : String(err)}`)
	}
	const gatedNote = () => `${meta.id} is gated: ${hf.hasToken ? 'the account behind HF_TOKEN has not been granted access' : 'set HF_TOKEN for an account that accepted its license'} to read config.json; the architecture page is skipped`

	if (fs.includes('model_index.json')) {
		const mi = await jsonFile<Obj>(hf, 'model', meta.id, 'model_index.json', r)
		if (mi.gated) warnings.push(gatedNote().replace('config.json', 'model_index.json'))
		facts.pipeline = analyzeModelIndex(mi.data)
		if (facts.pipeline) {
			facts.pipelineDetails = {}
			const want = facts.pipeline.components.filter((c) => (c.role === 'denoiser' || c.role === 'text_encoder' || c.role === 'vae') && fs.includes(`${c.name}/config.json`))
			await Promise.all(
				want.map(async (c) => {
					const cfg = await jsonFile<Obj>(hf, 'model', meta.id, `${c.name}/config.json`, r)
					const sum = cfg.data ? componentSummary(cfg.data) : ''
					if (sum) facts.pipelineDetails![c.name] = sum
				}),
			)
		}
	}
	if (fs.includes('config.json') && !facts.pipeline) {
		const cfg = await jsonFile<Obj>(hf, 'model', meta.id, 'config.json', r)
		if (cfg.gated) {
			facts.configGated = true
			warnings.push(gatedNote())
		} else if (!cfg.data) warnings.push('config.json could not be read')
		facts.spec = analyzeConfig(cfg.data)
		if (cfg.data && !facts.spec) warnings.push(`config.json (${asStr(cfg.data.model_type) ?? 'unknown model_type'}) is not a transformer config octo-draw understands`)
		for (const a of facts.spec?.assumed ?? []) warnings.push(a)
	}
	if (fs.includes('adapter_config.json')) {
		const ad = await jsonFile<Obj>(hf, 'model', meta.id, 'adapter_config.json', r)
		facts.adapter = ad.data
		if (ad.gated) warnings.push(gatedNote().replace('config.json', 'adapter_config.json'))
	}
	return facts
}

const ggufFiles = (m: ModelMeta) => files(m).filter((f) => f.toLowerCase().endsWith('.gguf'))

function quantOf(file: string): string {
	const m = /[-_.]((?:I?Q\d[\w]*?)|F16|F32|BF16|f16|f32|bf16)(?:-\d+-of-\d+)?\.gguf$/i.exec(file)
	return m ? m[1].toUpperCase() : file.replace(/\.gguf$/i, '')
}

function weightsLabel(m: ModelMeta): string | undefined {
	const fs = files(m)
	const formats: string[] = []
	const st = fs.filter((f) => f.endsWith('.safetensors'))
	if (st.length) formats.push(`safetensors${st.length > 1 ? ` (${st.length} files)` : ''}`)
	if (ggufFiles(m).length) formats.push(`GGUF (${ggufFiles(m).length} files)`)
	if (fs.some((f) => f.endsWith('.bin') && /pytorch_model|adapter_model/.test(f))) formats.push('PyTorch .bin')
	if (fs.some((f) => f.endsWith('.onnx'))) formats.push('ONNX')
	if (fs.some((f) => f.endsWith('.h5'))) formats.push('TF/Keras')
	if (fs.some((f) => f.endsWith('.msgpack'))) formats.push('Flax')
	if (fs.some((f) => /\.(mlpackage|mlmodel)/.test(f))) formats.push('Core ML')
	if (!formats.length) return undefined
	const dtypes = Object.keys(m.safetensors?.parameters ?? {})
	return `Weights: ${formats.join(', ')}${dtypes.length ? ` · ${dtypes.join('/')}` : ''}${m.usedStorage ? ` · ${humanBytes(m.usedStorage)} in repo` : ''}`
}

export interface ModelRender {
	root: Page
	pages: Page[]
	header: string[]
	notes: string[]
	confidence: number
}

/** Pure: facts → pages. `depth` 1 = root + Architecture/Pipeline; more levels pre-generate blocks and sublayers. */
export function renderModel(f: ModelFacts, srcBase: string, depth = 1, endpoint = 'https://huggingface.co'): ModelRender {
	const m = f.meta
	const card = cardOf(m)
	const tags = m.tags ?? []
	const root = new Page('', 'right')
	const pages: Page[] = []
	const notes: string[] = []
	const exact = m.safetensors?.total ?? m.gguf?.total
	const est = f.spec ? estimateParams(f.spec) : undefined
	const params = exact ?? est?.total
	const gguf = ggufFiles(m)

	const model = root.node(m.id, {
		label: `${shortName(m.id)}${params ? ` · ${exact ? '' : '≈ '}${humanCount(params)} params` : ''}${m.gated ? ' · gated' : ''}`,
		icon: 'huggingface',
		color: 'blue',
		link: hfUrl('model', m.id, endpoint),
		src: srcBase,
	})

	// lineage
	for (const l of f.lineage) {
		const lm = l.meta
		root.node(l.id, { label: `${shortName(l.id)}${lm?.safetensors?.total ? ` · ${humanCount(lm.safetensors.total)}` : ''}`, icon: 'huggingface', link: hfUrl('model', l.id, endpoint), src: `hf:${l.id}` })
		const rel = l.relation === 'adapter' && f.adapter && asStr(f.adapter.peft_type) ? `${asStr(f.adapter.peft_type)} adapter` : REL_LABEL[l.relation]
		root.edge(l.id, l.child, rel)
	}
	if (f.lineage.length) notes.push(`lineage: ${f.lineage.map((l) => `${l.id} (${l.relation})`).join(', ')}`)

	// training data
	const ds = datasetsOf(card, tags)
	if (ds.length) {
		const g = root.group('Training data', { label: `Training data (${ds.length})`, icon: 'database', src: `${srcBase}#datasets` })
		for (const d of ds.slice(0, 8)) root.node(`dataset ${d}`, { label: d, icon: 'database', shape: 'cylinder', parent: g, link: hfUrl('dataset', d, endpoint), src: `hf:datasets/${d}` })
		if (ds.length > 8) root.node('More datasets', { label: `+ ${ds.length - 8} more`, parent: g, src: `${srcBase}#datasets` })
		root.edge(g, model, 'trained on')
	}

	// license, task, library, weights
	const license = licenseOf(card, tags)
	if (license) {
		const link = asStr(card.license_link)
		root.node('License', { label: `License: ${license}`, icon: 'lock', shape: 'document', link: link?.startsWith('http') ? link : undefined, src: `${srcBase}#license` })
		root.edge(model, 'License', undefined, { dotted: true, plain: true })
	}
	const task = m.pipeline_tag ?? asStr(card.pipeline_tag) ?? m.transformersInfo?.pipeline_tag
	if (task) {
		root.node('Task', { label: `Task: ${task}`, icon: taskIcon(task), shape: 'oval', src: `${srcBase}#task` })
		root.edge(model, 'Task', 'pipeline_tag')
	}
	const lib = m.library_name ?? asStr(card.library_name) ?? (gguf.length ? 'gguf' : undefined)
	if (lib) {
		const libs = [lib, ...(gguf.length && lib !== 'gguf' ? ['gguf'] : []), ...['pytorch', 'tensorflow', 'jax', 'onnx', 'mlx'].filter((t) => tags.includes(t) && t !== lib)]
		root.node('Library', { label: `Library: ${libs.join(', ')}${m.transformersInfo?.auto_model ? ` · ${m.transformersInfo.auto_model}` : ''}`, icon: libraryIcon(lib), src: `${srcBase}#library` })
		root.edge('Library', model, 'loads', { dotted: true })
		for (const fw of ['pytorch', 'tensorflow'].filter((t) => tags.includes(t))) {
			root.node(fw === 'pytorch' ? 'PyTorch' : 'TensorFlow', { icon: fw, src: `${srcBase}#library.${fw}` })
			root.edge(fw === 'pytorch' ? 'PyTorch' : 'TensorFlow', 'Library', undefined, { dotted: true, plain: true })
		}
	}
	const w = weightsLabel(m)
	if (w) {
		root.node('Weights', { label: w, icon: 'file', shape: 'document', src: `${srcBase}#weights` })
		root.edge(model, 'Weights', undefined, { dotted: true, plain: true })
	}
	if (m.spaces?.length) {
		root.node('Spaces', { label: `Used by ${m.spaces.length >= 100 ? '100+' : m.spaces.length} Spaces`, icon: 'app', link: `${endpoint}/spaces?search=${encodeURIComponent(m.id)}`, src: `${srcBase}#spaces` })
		root.edge(model, 'Spaces', 'used by', { dotted: true })
	}

	// GGUF / adapter notes
	if (gguf.length) {
		const quants = [...new Set(gguf.map(quantOf))]
		root.node('GGUF', { shape: 'document', icon: 'cpu', label: `GGUF for llama.cpp · ${quants.length} quantizations: ${quants.slice(0, 8).join(', ')}${quants.length > 8 ? ', …' : ''}${m.gguf?.context_length ? ` · context ${m.gguf.context_length.toLocaleString('en-US')}` : ''}${m.gguf?.architecture ? ` · arch ${m.gguf.architecture}` : ''}`, src: `${srcBase}#gguf` })
		root.edge(model, 'GGUF', 'files')
		notes.push(`GGUF repo: ${quants.length} quantizations`)
	}
	if (f.adapter) {
		const a = f.adapter
		const targets = asArr(a.target_modules).map(String)
		const bits = [`${asStr(a.peft_type) ?? 'PEFT'} adapter`]
		if (a.r !== undefined) bits.push(`r=${a.r}`)
		if (a.lora_alpha !== undefined) bits.push(`α=${a.lora_alpha}`)
		if (targets.length) bits.push(`on ${targets.slice(0, 6).join(', ')}${targets.length > 6 ? ', …' : ''}`)
		if (asStr(a.task_type)) bits.push(String(a.task_type))
		root.node('Adapter', { shape: 'document', icon: 'layers', label: bits.join(' · '), src: `${srcBase}#adapter` })
		root.edge(model, 'Adapter', 'weights')
		const base = asStr(a.base_model_name_or_path)
		if (base && !root.has(base) && /^[\w.-]+\/[\w.-]+$/.test(base)) {
			root.node(base, { label: shortName(base), icon: 'huggingface', link: hfUrl('model', base, endpoint), src: `hf:${base}` })
			root.edge(base, model, bits[0])
		}
		notes.push(`adapter-only repo: ${bits.join(' ')}`)
	}

	// one level down
	const archCtx = { srcBase, params: exact }
	if (f.spec) {
		const arch = architecturePage(f.spec, archCtx, 'Architecture')
		root.node('Architecture', { label: `Architecture: ${f.spec.architecture ?? f.spec.modelType} · ${specSummary(f.spec)}`, icon: 'layers', drill: 'Architecture', src: `${srcBase}#architecture` })
		root.edge(model, 'Architecture', 'config.json')
		pages.push(arch)
		deepen(arch, depth - 1, (src, name) => expandArch(f.spec!, src.slice(src.indexOf('#') + 1), archCtx, name), (src) => isStructural(src.slice(src.indexOf('#') + 1)), pages)
		notes.push(`architecture: ${specSummary(f.spec)}`)
	} else if (f.pipeline) {
		const pp = pipelinePage(f.pipeline, srcBase, 'Pipeline', f.pipelineDetails)
		root.node('Pipeline', { label: `Pipeline: ${f.pipeline.cls} · ${f.pipeline.components.length} components`, icon: 'workflow', drill: 'Pipeline', src: `${srcBase}#pipeline` })
		root.edge(model, 'Pipeline', 'model_index.json')
		pages.push(pp)
		notes.push(`diffusers pipeline: ${f.pipeline.cls} (${f.pipeline.components.map((c) => c.name).join(', ')})`)
	} else if (f.configGated) {
		root.node('Architecture', { shape: 'document', icon: 'lock', label: `Architecture: ${asStr(asObj(m.config).model_type) ?? 'unknown'} · config.json is gated (set HF_TOKEN after accepting the license)`, src: `${srcBase}#architecture` })
		root.edge(model, 'Architecture', undefined, { dotted: true })
	}

	const header = [
		`source: ${hfUrl('model', m.id, endpoint)}`,
		...(m.downloads !== undefined ? [`downloads (30d): ${m.downloads.toLocaleString('en-US')} · likes: ${m.likes ?? 0}`] : []),
		...(exact ? [`parameters: ${exact.toLocaleString('en-US')} (from ${m.safetensors?.total ? 'safetensors' : 'GGUF'} metadata)`] : est ? [`parameters: ≈ ${humanCount(est.total)} (estimated from config.json)`] : []),
	]
	const confidence = f.spec || f.pipeline ? 0.9 : gguf.length || f.adapter ? 0.7 : 0.5
	return { root, pages, header, notes, confidence }
}
