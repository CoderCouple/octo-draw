/**
 * Spaces: SDK, hardware, card `models`/`datasets`, and a best-effort read of
 * the app code (app file, other small .py files, requirements.txt,
 * Dockerfile) for transformers/diffusers pipelines, `InferenceClient`,
 * external LLM APIs, vector DBs and the UI components wired to handlers.
 * Rendered as a request flow: user → UI → handlers → model calls → outputs.
 */

import { asStr, uniq } from '../../util'
import { cardOf, strList } from './card'
import type { HfClient } from './client'
import { icon, Page, shortName } from './graph'
import { hfUrl } from './parse'

export interface SpaceMeta {
	id: string
	sdk?: string
	cardData?: unknown
	tags?: string[]
	models?: string[]
	datasets?: string[]
	siblings?: { rfilename: string }[]
	runtime?: { stage?: string; hardware?: { current?: string | null; requested?: string | null } }
	host?: string
	likes?: number
	private?: boolean
	gated?: unknown
}

export type CallKind = 'local' | 'inference' | 'api'

export interface ModelCall {
	/** Repo id (`org/name`) or API name (`OpenAI API`). */
	target: string
	via: string
	kind: CallKind
	task?: string
}

export interface ExternalUse {
	name: string
	icon?: string
	kind: 'llm-api' | 'vector-db' | 'framework' | 'http' | 'data' | 'storage'
	detail?: string
}

export interface AppAnalysis {
	framework?: string
	/** `Blocks`, `Interface`, `ChatInterface`, ... */
	ui?: string
	inputs: string[]
	outputs: string[]
	components: string[]
	handlers: string[]
	gpuHandlers: string[]
	calls: ModelCall[]
	externals: ExternalUse[]
	datasets: string[]
	imports: string[]
	requirements: string[]
	docker?: { from?: string; port?: string; cmd?: string }
}

const REPO = /^[A-Za-z0-9][\w.-]*\/[\w.-]+$/

const LLM_APIS: { mod: RegExp; pkg: string[]; name: string; icon: string[] }[] = [
	{ mod: /^openai\b/, pkg: ['openai'], name: 'OpenAI API', icon: ['openai'] },
	{ mod: /^anthropic\b/, pkg: ['anthropic'], name: 'Anthropic API', icon: ['anthropic', 'claude'] },
	{ mod: /^google\.(generativeai|genai)\b|^vertexai\b/, pkg: ['google-generativeai', 'google-genai'], name: 'Gemini API', icon: ['gemini'] },
	{ mod: /^groq\b/, pkg: ['groq'], name: 'Groq API', icon: ['zap'] },
	{ mod: /^mistralai\b/, pkg: ['mistralai'], name: 'Mistral API', icon: ['mistral'] },
	{ mod: /^cohere\b/, pkg: ['cohere'], name: 'Cohere API', icon: ['ai'] },
	{ mod: /^together\b/, pkg: ['together'], name: 'Together API', icon: ['ai'] },
	{ mod: /^replicate\b/, pkg: ['replicate'], name: 'Replicate API', icon: ['ai'] },
	{ mod: /^fal_client\b/, pkg: ['fal-client'], name: 'fal.ai API', icon: ['ai'] },
	{ mod: /^litellm\b/, pkg: ['litellm'], name: 'LiteLLM', icon: ['llm'] },
	{ mod: /^ollama\b/, pkg: ['ollama'], name: 'Ollama', icon: ['ollama'] },
	{ mod: /^elevenlabs\b/, pkg: ['elevenlabs'], name: 'ElevenLabs API', icon: ['ai'] },
]

const VECTOR_DBS: { mod: RegExp; pkg: string[]; name: string; icon: string[] }[] = [
	{ mod: /^chromadb\b|vectorstores.*chroma|langchain_chroma/i, pkg: ['chromadb', 'langchain-chroma'], name: 'Chroma', icon: ['database'] },
	{ mod: /^faiss\b|vectorstores.*faiss/i, pkg: ['faiss-cpu', 'faiss-gpu', 'faiss'], name: 'FAISS index', icon: ['database'] },
	{ mod: /^pinecone\b|langchain_pinecone/, pkg: ['pinecone-client', 'pinecone', 'langchain-pinecone'], name: 'Pinecone', icon: ['database'] },
	{ mod: /^qdrant_client\b|langchain_qdrant/, pkg: ['qdrant-client', 'langchain-qdrant'], name: 'Qdrant', icon: ['database'] },
	{ mod: /^weaviate\b/, pkg: ['weaviate-client'], name: 'Weaviate', icon: ['database'] },
	{ mod: /^lancedb\b/, pkg: ['lancedb'], name: 'LanceDB', icon: ['database'] },
	{ mod: /^pymilvus\b/, pkg: ['pymilvus'], name: 'Milvus', icon: ['database'] },
	{ mod: /^pgvector\b|^psycopg/, pkg: ['pgvector', 'psycopg2', 'psycopg2-binary', 'psycopg'], name: 'Postgres', icon: ['postgres'] },
	{ mod: /^redis\b/, pkg: ['redis'], name: 'Redis', icon: ['redis'] },
	{ mod: /^supabase\b/, pkg: ['supabase'], name: 'Supabase', icon: ['supabase'] },
	{ mod: /^pymongo\b/, pkg: ['pymongo'], name: 'MongoDB', icon: ['mongodb'] },
]

const FRAMEWORKS: { mod: RegExp; pkg: string[]; name: string; icon: string[] }[] = [
	{ mod: /^langchain/, pkg: ['langchain', 'langchain-community', 'langchain-core', 'langchain-openai', 'langgraph'], name: 'LangChain', icon: ['langchain'] },
	{ mod: /^llama_index/, pkg: ['llama-index', 'llama_index'], name: 'LlamaIndex', icon: ['llm'] },
	{ mod: /^smolagents\b/, pkg: ['smolagents'], name: 'smolagents', icon: ['agent', 'huggingface'] },
	{ mod: /^haystack\b/, pkg: ['haystack-ai', 'farm-haystack'], name: 'Haystack', icon: ['search'] },
	{ mod: /^sentence_transformers\b/, pkg: ['sentence-transformers'], name: 'sentence-transformers', icon: ['huggingface'] },
	{ mod: /^llama_cpp\b/, pkg: ['llama-cpp-python'], name: 'llama.cpp', icon: ['cpu'] },
	{ mod: /^vllm\b/, pkg: ['vllm'], name: 'vLLM', icon: ['server'] },
	{ mod: /^fastapi\b/, pkg: ['fastapi'], name: 'FastAPI', icon: ['fastapi'] },
	{ mod: /^flask\b/, pkg: ['flask'], name: 'Flask', icon: ['flask'] },
]

const GR_COMPONENTS = new Set(['Textbox', 'Text', 'TextArea', 'Number', 'Slider', 'Checkbox', 'CheckboxGroup', 'Radio', 'Dropdown', 'Image', 'ImageEditor', 'Sketchpad', 'Gallery', 'Audio', 'Microphone', 'Video', 'File', 'Files', 'UploadButton', 'Chatbot', 'Markdown', 'HTML', 'JSON', 'Label', 'Dataframe', 'DataFrame', 'Model3D', 'Plot', 'LinePlot', 'BarPlot', 'ScatterPlot', 'HighlightedText', 'AnnotatedImage', 'Code', 'ColorPicker', 'MultimodalTextbox', 'DownloadButton', 'Video', 'Button', 'ClearButton', 'ImageSlider'])
const NON_DATA = new Set(['Button', 'ClearButton', 'UploadButton', 'DownloadButton', 'Markdown', 'HTML'])
/** Controls that are inputs even when a handler writes back to them (a seed slider). */
const CONTROLS = new Set(['Slider', 'Checkbox', 'CheckboxGroup', 'Radio', 'Dropdown', 'ColorPicker'])

const TASK_OF_CLASS: [RegExp, string][] = [
	[/CausalLM|ForConditionalGeneration|TextGeneration/, 'text-generation'],
	[/Diffusion|Flux|Kandinsky|PixArt|Sana|Pipeline$/, 'text-to-image'],
	[/SpeechSeq2Seq|Whisper|CTC/, 'automatic-speech-recognition'],
	[/SequenceClassification/, 'text-classification'],
	[/SentenceTransformer/, 'sentence-similarity'],
]

function lineImports(code: string): string[] {
	const out: string[] = []
	for (const m of code.matchAll(/^[ \t]*(?:from[ \t]+([\w.]+)[ \t]+import|import[ \t]+([\w., \t]+))/gm)) {
		if (m[1]) out.push(m[1])
		else for (const p of m[2].split(',')) out.push(p.trim().split(/\s+/)[0])
	}
	return out.filter(Boolean)
}

/** `requirements.txt` → normalized package names. */
export function parseRequirements(text: string): string[] {
	const out: string[] = []
	for (const raw of text.split(/\r?\n/)) {
		const l = raw.replace(/#.*$/, '').trim()
		if (!l || l.startsWith('-')) continue
		const git = /^git\+https?:\/\/[^/]+\/[^/]+\/([\w.-]+?)(?:\.git)?(?:@.*)?$/.exec(l)
		if (git) {
			out.push(git[1].toLowerCase())
			continue
		}
		const m = /^([A-Za-z0-9][\w.-]*)/.exec(l)
		if (m) out.push(m[1].toLowerCase().replace(/_/g, '-'))
	}
	return uniq(out)
}

function dockerInfo(text: string): AppAnalysis['docker'] {
	const from = /^\s*FROM\s+(\S+)/im.exec(text)?.[1]
	const port = /^\s*EXPOSE\s+(\d+)/im.exec(text)?.[1]
	const cmd = /^\s*(?:CMD|ENTRYPOINT)\s+(.+)$/im.exec(text)?.[1]?.replace(/[[\]"]/g, '').replace(/,\s*/g, ' ').trim()
	return { from, port, cmd }
}

function strArg(s: string): string | undefined {
	return /^\s*f?["']([^"']+)["']/.exec(s)?.[1]
}

/** Pure: analyze the app files of a Space. `files` maps repo path → text. */
export function analyzeApp(files: Map<string, string>, sdk?: string): AppAnalysis {
	const a: AppAnalysis = { framework: sdk, inputs: [], outputs: [], components: [], handlers: [], gpuHandlers: [], calls: [], externals: [], datasets: [], imports: [], requirements: [] }
	const py = [...files].filter(([p]) => p.endsWith('.py'))
	const code = py.map(([, t]) => t).join('\n')
	const req = files.get('requirements.txt')
	if (req) a.requirements = parseRequirements(req)
	const dockerfile = files.get('Dockerfile')
	if (dockerfile) a.docker = dockerInfo(dockerfile)
	a.imports = uniq(lineImports(code))
	const has = (mod: RegExp, pkgs: string[]) => a.imports.some((i) => mod.test(i)) || pkgs.some((p) => a.requirements.includes(p))

	// constants: NAME = "org/model"
	const consts = new Map<string, string>()
	for (const m of code.matchAll(/^[ \t]*([A-Za-z_]\w*)[ \t]*=[ \t]*["']([^"'\n]+)["']/gm)) consts.set(m[1], m[2])
	const value = (expr: string | undefined): string | undefined => {
		if (!expr) return undefined
		const s = strArg(expr)
		if (s) return s
		const id = /^\s*([A-Za-z_]\w*)\s*[,)]/.exec(expr + ')')?.[1]
		return id ? consts.get(id) : undefined
	}
	const addCall = (c: ModelCall) => {
		const hit = a.calls.find((x) => x.target.toLowerCase() === c.target.toLowerCase())
		if (!hit) a.calls.push(c)
		else if (!hit.via.split(', ').includes(c.via)) hit.via += `, ${c.via}`
	}

	// transformers pipeline(...)
	for (const m of code.matchAll(/\bpipeline\(\s*([^)]*)\)/g)) {
		const args = m[1]
		const task = strArg(args) ?? strArg(/task\s*=\s*(.*)/.exec(args)?.[1] ?? '')
		const model = value(/model\s*=\s*([^,)]+)/.exec(args)?.[1])
		addCall({ target: model && REPO.test(model) ? model : `transformers pipeline${task ? ` (${task})` : ''}`, via: `pipeline(${task ? `"${task}"` : ''})`, kind: 'local', task })
	}
	// X.from_pretrained("org/name")
	for (const m of code.matchAll(/\b(\w+)\.from_pretrained\(\s*([^,)\n]+)/g)) {
		const id = value(m[2])
		if (!id || !REPO.test(id)) continue
		if (/Tokenizer|Processor|FeatureExtractor|Config|Scheduler$/.test(m[1])) continue
		const task = TASK_OF_CLASS.find(([re]) => re.test(m[1]))?.[1]
		addCall({ target: id, via: `${m[1]}.from_pretrained`, kind: 'local', task })
	}
	// SentenceTransformer("org/name"), gr.load("models/org/name")
	for (const m of code.matchAll(/\bSentenceTransformer\(\s*([^,)\n]+)/g)) {
		const id = value(m[1])
		if (id) addCall({ target: id, via: 'SentenceTransformer', kind: 'local', task: 'sentence-similarity' })
	}
	for (const m of code.matchAll(/\bgr\.(?:Interface\.)?load\(\s*["'](?:models\/)?([^"']+)["']/g)) if (REPO.test(m[1])) addCall({ target: m[1], via: 'gr.load', kind: 'inference' })
	// huggingface_hub InferenceClient
	if (/\bInferenceClient\b|\bAsyncInferenceClient\b/.test(code)) {
		let found = false
		for (const m of code.matchAll(/\b(?:Async)?InferenceClient\(\s*([^)]*)\)/g)) {
			const id = value(m[1]) ?? value(/model\s*=\s*([^,)]+)/.exec(m[1])?.[1])
			if (id && REPO.test(id)) {
				addCall({ target: id, via: 'InferenceClient', kind: 'inference' })
				found = true
			}
		}
		for (const m of code.matchAll(/\.(chat_completion|text_generation|text_to_image|chat\.completions\.create|automatic_speech_recognition|feature_extraction|image_to_text|text_to_speech)\(([^)]*)\)/g)) {
			const id = value(/model\s*=\s*([^,)]+)/.exec(m[2])?.[1])
			if (id && REPO.test(id)) {
				addCall({ target: id, via: `InferenceClient.${m[1].split('.')[0]}`, kind: 'inference' })
				found = true
			}
		}
		if (!found) addCall({ target: 'HF Inference API', via: 'InferenceClient', kind: 'inference' })
	}
	// external LLM APIs
	for (const api of LLM_APIS) {
		if (!has(api.mod, api.pkg)) continue
		let name = api.name
		if (api.name === 'OpenAI API') {
			const base = /base_url\s*=\s*f?["']https?:\/\/([^/"']+)/.exec(code)?.[1]
			if (base) name = base.includes('huggingface.co') ? 'HF Inference Providers (OpenAI-compatible)' : `OpenAI-compatible API (${base})`
		}
		const model = /model\s*=\s*["']([^"']+)["']/.exec(code)?.[1]
		addCall({ target: name, via: api.name.replace(/ API$/, '').toLowerCase() + ' SDK', kind: name.startsWith('HF Inference') ? 'inference' : 'api', task: model })
		a.externals.push({ name, icon: icon(...api.icon) ?? undefined, kind: 'llm-api', detail: model })
	}
	for (const db of VECTOR_DBS) if (has(db.mod, db.pkg)) a.externals.push({ name: db.name, icon: icon(...db.icon) ?? undefined, kind: 'vector-db' })
	for (const fw of FRAMEWORKS) if (has(fw.mod, fw.pkg)) a.externals.push({ name: fw.name, icon: icon(...fw.icon) ?? undefined, kind: 'framework' })
	// raw HTTP APIs
	for (const m of code.matchAll(/\b(?:requests|httpx|aiohttp\.ClientSession\(\)|session|client)\.(?:get|post|put|stream)\(\s*f?["']https?:\/\/([^/"'{}]+)/g)) {
		const host = m[1]
		if (!a.externals.some((e) => e.name === host)) a.externals.push({ name: host, icon: icon('globe') ?? undefined, kind: 'http' })
	}
	// datasets
	for (const m of code.matchAll(/\bload_dataset\(\s*([^,)\n]+)/g)) {
		const id = value(m[1])
		if (id && REPO.test(id)) a.datasets.push(id)
	}
	for (const m of code.matchAll(/\b(?:hf_hub_download|snapshot_download)\(\s*(?:repo_id\s*=\s*)?([^,)\n]+)/g)) {
		const id = value(m[1])
		if (id && REPO.test(id)) addCall({ target: id, via: 'hf_hub_download', kind: 'local' })
	}
	a.datasets = uniq(a.datasets)

	// UI
	const vars = new Map<string, string>()
	if (/\bimport gradio\b|\bfrom gradio\b/.test(code) || sdk === 'gradio') {
		a.framework = 'gradio'
		a.ui = /\bgr\.ChatInterface\(/.test(code) ? 'ChatInterface' : /\bgr\.Interface\(/.test(code) ? 'Interface' : /\bgr\.Blocks\(/.test(code) ? 'Blocks' : /\bgr\.TabbedInterface\(/.test(code) ? 'TabbedInterface' : undefined
		for (const m of code.matchAll(/\b([A-Za-z_]\w*)\s*=\s*gr\.(\w+)\(/g)) if (GR_COMPONENTS.has(m[2])) vars.set(m[1], m[2])
		for (const m of code.matchAll(/\bgr\.(\w+)\(/g)) if (GR_COMPONENTS.has(m[1]) && !NON_DATA.has(m[1])) a.components.push(m[1])
		a.components = uniq(a.components)
		const collect = (kw: 'inputs' | 'outputs') => {
			const out: string[] = []
			for (const m of code.matchAll(new RegExp(`\\b${kw}\\s*=\\s*(\\[[^\\]]*\\]|[^,)\\n]+)`, 'g'))) {
				for (const tok of m[1].replace(/[[\]]/g, '').split(',')) {
					const t = tok.trim()
					const comp = /^gr\.(\w+)/.exec(t)?.[1] ?? vars.get(t) ?? (/^["'](\w+)["']$/.exec(t)?.[1] ? t.replace(/["']/g, '').replace(/^\w/, (c) => c.toUpperCase()) : undefined)
					if (comp && !NON_DATA.has(comp)) out.push(comp)
				}
			}
			// .click(fn, [in...], [out...]) positional form
			for (const m of code.matchAll(/\.(?:click|submit|change|upload|input|then|stream)\(\s*\w+\s*,\s*(\[[^\]]*\]|\w+)\s*,\s*(\[[^\]]*\]|\w+)/g)) {
				const list = kw === 'inputs' ? m[1] : m[2]
				for (const tok of list.replace(/[[\]]/g, '').split(',')) {
					const comp = vars.get(tok.trim())
					if (comp && !NON_DATA.has(comp)) out.push(comp)
				}
			}
			return uniq(out)
		}
		a.inputs = collect('inputs')
		a.outputs = collect('outputs').filter((o) => !CONTROLS.has(o))
		if (a.ui === 'ChatInterface') {
			if (!a.inputs.length) a.inputs = ['Textbox']
			if (!a.outputs.length) a.outputs = ['Chatbot']
		}
		const handlers: string[] = []
		for (const m of code.matchAll(/\.(?:click|submit|change|upload|input|then|stream|release|select)\(\s*(?:fn\s*=\s*)?([A-Za-z_]\w*)\s*[,)]/g)) handlers.push(m[1])
		for (const m of code.matchAll(/\bgr\.(?:Chat)?Interface\(\s*(?:fn\s*=\s*)?([A-Za-z_]\w*)/g)) handlers.push(m[1])
		for (const m of code.matchAll(/\bfn\s*=\s*([A-Za-z_]\w*)/g)) handlers.push(m[1])
		const defined = new Set([...code.matchAll(/^\s*(?:async\s+)?def\s+(\w+)/gm)].map((m) => m[1]))
		a.handlers = uniq(handlers).filter((h) => defined.has(h) && h !== 'lambda')
	} else if (/\bimport streamlit\b/.test(code) || sdk === 'streamlit') {
		a.framework = 'streamlit'
		a.ui = 'app'
		const ins = new Map<string, string>([['chat_input', 'Chat input'], ['text_input', 'Text input'], ['text_area', 'Text area'], ['file_uploader', 'File upload'], ['camera_input', 'Camera'], ['slider', 'Slider'], ['selectbox', 'Select'], ['audio_input', 'Audio input']])
		const outs = new Map<string, string>([['chat_message', 'Chat message'], ['image', 'Image'], ['audio', 'Audio'], ['video', 'Video'], ['dataframe', 'Table'], ['plotly_chart', 'Chart'], ['line_chart', 'Chart'], ['json', 'JSON'], ['write_stream', 'Streamed text']])
		for (const m of code.matchAll(/\bst\.(?:sidebar\.)?(\w+)\(/g)) {
			if (ins.has(m[1])) a.inputs.push(ins.get(m[1])!)
			if (outs.has(m[1])) a.outputs.push(outs.get(m[1])!)
		}
		a.inputs = uniq(a.inputs)
		a.outputs = uniq(a.outputs)
	}
	// ZeroGPU
	for (const m of code.matchAll(/@spaces\.GPU(?:\([^)]*\))?\s*\n\s*(?:async\s+)?def\s+(\w+)/g)) a.gpuHandlers.push(m[1])
	if (!a.handlers.length && a.gpuHandlers.length) a.handlers = [...a.gpuHandlers]
	return a
}

const OUTPUT_LABEL: Record<string, string> = { Image: 'Image', Gallery: 'Images', AnnotatedImage: 'Annotated image', ImageSlider: 'Image comparison', Chatbot: 'Chat reply', Audio: 'Audio', Video: 'Video', Textbox: 'Text', Text: 'Text', Markdown: 'Text', JSON: 'JSON', Label: 'Labels', Dataframe: 'Table', DataFrame: 'Table', Model3D: '3D model', Plot: 'Chart', HighlightedText: 'Highlighted text', File: 'File', Files: 'Files', Code: 'Code' }

function outputsLabel(a: AppAnalysis, calls: ModelCall[]): string {
	if (a.outputs.length) return uniq(a.outputs.map((o) => OUTPUT_LABEL[o] ?? o)).join(', ')
	if (a.components.includes('Chatbot')) return 'Chat reply'
	const task = calls.find((c) => c.task)?.task ?? ''
	if (/image/.test(task)) return 'Image'
	if (/speech-recognition/.test(task)) return 'Transcript'
	if (/text/.test(task)) return 'Text'
	if (a.components.includes('Gallery') || a.components.includes('Image')) return 'Image'
	return 'Results'
}

export interface SpaceFacts {
	meta: SpaceMeta
	files: Map<string, string>
	app: AppAnalysis
	warnings: string[]
}

const MAX_PY = 6
const MAX_FILE = 200_000

export async function collectSpace(hf: HfClient, id: string, rev: string | undefined): Promise<SpaceFacts> {
	const meta = await hf.repo<SpaceMeta>('space', id, rev)
	const warnings: string[] = []
	const card = cardOf(meta)
	const names = (meta.siblings ?? []).map((s) => s.rfilename)
	const appFile = asStr(card.app_file) ?? (names.includes('app.py') ? 'app.py' : names.find((n) => n.endsWith('.py') && !n.includes('/')))
	const want = uniq([appFile, 'requirements.txt', 'Dockerfile', 'pre-requirements.txt', ...names.filter((n) => n.endsWith('.py') && n.split('/').length <= 2 && !/test/i.test(n))].filter((n): n is string => !!n && names.includes(n)))
	const picked = want.slice(0, MAX_PY + 3)
	const files = new Map<string, string>()
	let gated = false
	await Promise.all(
		picked.map(async (path) => {
			const r = await hf.file('space', id, path, rev)
			if (r.ok) {
				if (r.text.length <= MAX_FILE) files.set(path, r.text)
			} else if (r.gated) gated = true
		}),
	)
	if (gated) warnings.push(`some app files of ${id} are not readable without HF_TOKEN (private or gated Space)`)
	if (want.length > picked.length) warnings.push(`read ${picked.length} of ${want.length} app files`)
	if (!files.size) warnings.push(meta.sdk === 'static' ? 'static Space: no server-side app code' : 'no app code could be read')
	const sorted = new Map([...files].sort((a, b) => (a[0] === appFile ? -1 : b[0] === appFile ? 1 : a[0].localeCompare(b[0]))))
	return { meta, files: sorted, app: analyzeApp(sorted, meta.sdk), warnings }
}

export interface SpaceRender {
	root: Page
	pages: Page[]
	header: string[]
	notes: string[]
	confidence: number
}

const SDK_ICON: Record<string, string[]> = { gradio: ['gradio', 'app'], streamlit: ['streamlit', 'app'], docker: ['docker'], static: ['globe', 'browser'] }

/** App code page: files → libraries and services they use. */
export function appCodePage(f: SpaceFacts, srcBase: string, name: string, endpoint: string): Page {
	const p = new Page(name, 'right')
	const a = f.app
	const link = (path: string) => `${endpoint}/spaces/${f.meta.id}/blob/main/${path}`
	for (const path of f.files.keys()) p.node(path, { icon: path.endsWith('.py') ? 'python' : path === 'Dockerfile' ? 'docker' : 'file', shape: path.endsWith('.py') ? undefined : 'document', link: link(path), src: `${srcBase}#file/${path}` })
	const main = [...f.files.keys()].find((k) => k.endsWith('.py'))
	const ml = a.imports.filter((i) => /^(torch|transformers|diffusers|accelerate|peft|spaces|huggingface_hub|datasets|sentence_transformers|timm|onnxruntime|optimum|xformers|bitsandbytes|safetensors)\b/.test(i)).map((i) => i.split('.')[0])
	if (ml.length) {
		const g = p.group('ML libraries', { src: `${srcBase}#deps/ml` })
		for (const lib of uniq(ml)) p.node(`lib ${lib}`, { label: lib, icon: lib === 'torch' ? 'pytorch' : lib === 'transformers' || lib === 'diffusers' || lib === 'huggingface_hub' || lib === 'datasets' || lib === 'spaces' ? 'huggingface' : 'package', parent: g, src: `${srcBase}#deps/${lib}` })
		if (main) p.edge(main, g, 'imports')
	}
	if (a.externals.length) {
		const g = p.group('Services', { label: 'Services and frameworks', src: `${srcBase}#deps/services` })
		for (const e of a.externals) p.node(`svc ${e.name}`, { label: `${e.name}${e.detail ? ` · ${e.detail}` : ''}`, icon: e.icon, parent: g, shape: e.kind === 'vector-db' ? 'cylinder' : undefined, src: `${srcBase}#deps/${e.name}` })
		if (main) p.edge(main, g, 'uses')
	}
	if (a.requirements.length && f.files.has('requirements.txt')) {
		p.node('Requirements', { shape: 'document', label: `requirements: ${a.requirements.slice(0, 12).join(', ')}${a.requirements.length > 12 ? `, +${a.requirements.length - 12}` : ''}`, src: `${srcBase}#file/requirements.txt` })
		p.edge('requirements.txt', 'Requirements', undefined, { dotted: true, plain: true })
	}
	if (a.docker && f.files.has('Dockerfile')) {
		p.node('Container', { icon: 'docker', label: `Container · FROM ${a.docker.from ?? '?'}${a.docker.port ? ` · port ${a.docker.port}` : ''}${a.docker.cmd ? ` · ${a.docker.cmd.slice(0, 60)}` : ''}`, src: `${srcBase}#docker` })
		p.edge('Dockerfile', 'Container', 'builds')
	}
	return p
}

export function renderSpace(f: SpaceFacts, srcBase: string, endpoint = 'https://huggingface.co'): SpaceRender {
	const m = f.meta
	const card = cardOf(m)
	const a = f.app
	const root = new Page('', 'right')
	const pages: Page[] = []
	const sdk = m.sdk ?? asStr(card.sdk) ?? a.framework ?? 'unknown'
	const hw = m.runtime?.hardware?.current ?? m.runtime?.hardware?.requested ?? undefined
	const sdkVersion = asStr(card.sdk_version)
	const title = asStr(card.title)

	const user = root.node('User', { icon: 'user', shape: 'oval', src: `${srcBase}#user` })
	const space = root.group('Space', { label: `Space ${m.id} · ${sdk}${sdkVersion ? ` ${sdkVersion}` : ''}${hw ? ` · ${hw}` : ''}${m.runtime?.stage && m.runtime.stage !== 'RUNNING' ? ` · ${m.runtime.stage.toLowerCase()}` : ''}`, link: hfUrl('space', m.id, endpoint), src: srcBase })
	const uiParts = [`${sdk === 'gradio' ? 'Gradio' : sdk === 'streamlit' ? 'Streamlit' : sdk === 'docker' ? 'Web app' : sdk === 'static' ? 'Static page' : 'UI'}${a.ui && a.ui !== 'app' ? ` ${a.ui}` : ''}`]
	if (title) uiParts.push(`"${title}"`.replace(/"/g, ''))
	if (a.inputs.length) uiParts.push(`in: ${a.inputs.slice(0, 4).join(', ')}`)
	const ui = root.node('UI', { label: uiParts.join(' · '), icon: icon(...(SDK_ICON[sdk] ?? ['app'])) ?? undefined, parent: space, src: `${srcBase}#ui` })
	root.edge(user, ui, a.inputs.length ? a.inputs.slice(0, 3).join(', ').toLowerCase() : 'request')

	// handlers
	const handlers = a.handlers.slice(0, 5)
	const hk = handlers.map((h) => root.node(`${h}()`, { label: `${h}()${a.gpuHandlers.includes(h) ? ' · @spaces.GPU (ZeroGPU)' : ''}`, icon: 'function', parent: space, src: `${srcBase}#app/${h}` }))
	if (a.handlers.length > handlers.length) hk.push(root.node('More handlers', { label: `+ ${a.handlers.length - handlers.length} more handlers`, parent: space, src: `${srcBase}#app` }))
	if (!hk.length && f.files.size) hk.push(root.node('App code', { label: `${[...f.files.keys()][0]}`, icon: 'python', parent: space, src: `${srcBase}#app` }))
	for (const h of hk) root.edge(ui, h, 'event')
	const from = hk.length ? hk : [ui]

	// model calls
	const calls = a.calls.slice(0, 8)
	const callKeys: string[] = []
	const cardModels = uniq([...(m.models ?? []), ...strList(card.models)])
	for (const c of calls) {
		const isRepo = REPO.test(c.target)
		const where = c.kind === 'local' ? (hw && hw !== 'cpu-basic' && hw !== 'cpu-upgrade' ? `local on ${hw}` : 'local') : c.kind === 'inference' ? 'HF Inference' : 'external API'
		const k = root.node(c.target, {
			label: `${isRepo ? shortName(c.target) : c.target} · ${c.via} · ${where}${c.task && !isRepo ? ` · ${c.task}` : ''}`,
			icon: isRepo || c.kind === 'inference' ? 'huggingface' : (a.externals.find((e) => e.name === c.target)?.icon ?? 'ai'),
			link: isRepo ? hfUrl('model', c.target, endpoint) : undefined,
			src: isRepo ? `hf:${c.target}` : `${srcBase}#call/${c.target}`,
		})
		callKeys.push(k)
		for (const h of from) root.edge(h, k, c.kind === 'api' ? 'API call' : c.kind === 'inference' ? 'inference' : 'runs')
	}
	// card models not seen in the code
	const extra = cardModels.filter((id) => !calls.some((c) => c.target.toLowerCase() === id.toLowerCase())).slice(0, 8)
	if (extra.length) {
		const g = root.group('Card models', { label: 'Models (from the Space card)', src: `${srcBase}#models` })
		for (const id of extra) root.node(id, { label: shortName(id), icon: 'huggingface', parent: g, link: hfUrl('model', id, endpoint), src: `hf:${id}` })
		root.edge(from[0], g, 'uses', { dotted: true })
		if (!callKeys.length) callKeys.push(g)
	}
	// vector DBs / frameworks / http
	for (const e of a.externals) {
		if (e.kind === 'llm-api') continue
		const k = root.node(e.name, { icon: e.icon, shape: e.kind === 'vector-db' ? 'cylinder' : undefined, src: `${srcBase}#deps/${e.name}` })
		if (e.kind === 'vector-db') root.edge(from[0], k, 'retrieve')
		else if (e.kind === 'http') root.edge(from[0], k, 'HTTP')
		else root.edge(from[0], k, 'uses', { dotted: true })
	}
	const datasets = uniq([...(m.datasets ?? []), ...strList(card.datasets), ...a.datasets]).slice(0, 6)
	for (const d of datasets) {
		const k = root.node(`dataset ${d}`, { label: d, icon: 'database', shape: 'cylinder', link: hfUrl('dataset', d, endpoint), src: `hf:datasets/${d}` })
		root.edge(from[0], k, 'loads', { dotted: true })
	}
	// outputs
	const out = root.node('Outputs', { label: outputsLabel(a, calls), shape: 'oval', src: `${srcBase}#outputs` })
	for (const k of callKeys.length ? callKeys : from) root.edge(k, out)
	root.edge(out, user, 'shown in UI', { dotted: true })

	// one level down: the app code
	if (f.files.size) {
		const page = appCodePage(f, srcBase, 'App code', endpoint)
		root.node('App files', { label: `App code · ${[...f.files.keys()].join(', ')}`, shape: 'document', icon: 'code', drill: 'App code', src: `${srcBase}#app` })
		root.edge(space, 'App files', undefined, { dotted: true, plain: true })
		pages.push(page)
	}
	const header = [`source: ${hfUrl('space', m.id, endpoint)}`, `sdk: ${sdk}${sdkVersion ? ` ${sdkVersion}` : ''}${hw ? ` · hardware: ${hw}` : ''}`, ...(m.likes !== undefined ? [`likes: ${m.likes}`] : [])]
	const notes = [`sdk ${sdk}`, ...(hw ? [`hardware ${hw}`] : []), `${a.calls.length} model call(s): ${a.calls.map((c) => c.target).join(', ') || 'none found'}`, ...(a.externals.length ? [`services: ${a.externals.map((e) => e.name).join(', ')}`] : []), `${f.files.size} app file(s) read`]
	return { root, pages, header, notes, confidence: f.files.size ? (a.calls.length ? 0.8 : 0.6) : 0.4 }
}
