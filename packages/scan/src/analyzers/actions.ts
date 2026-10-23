/**
 * GitHub Actions workflows (`.github/workflows/*.yml`) → a "CI/CD" page:
 * one group per workflow (labelled with its triggers), jobs inside, `needs`
 * edges between jobs, and deploy targets inferred from the actions a job uses.
 */

import type { ArchEdge, ArchNode, ArchPage, ScanFiles } from '../types'
import { asArr, asObj, asStr, basename, isObj, KeyAllocator, parseYaml, plural } from '../util'

interface Target {
	key: string
	icon: string
}

/** `uses:` prefix (or `run:` pattern) → deploy target. First match wins. */
const USES: [RegExp, Target][] = [
	[/^aws-actions\/amazon-ecr/, { key: 'Amazon ECR', icon: 'aws-ecr' }],
	[/^aws-actions\/amazon-ecs/, { key: 'Amazon ECS', icon: 'aws-ecs' }],
	[/^aws-actions\/aws-cloudformation/, { key: 'CloudFormation', icon: 'aws-cloudformation' }],
	[/^aws-actions\//, { key: 'AWS', icon: 'aws' }],
	[/^google-github-actions\/deploy-cloudrun/, { key: 'Cloud Run', icon: 'gcp-cloud-run' }],
	[/^google-github-actions\/deploy-cloud-functions/, { key: 'Cloud Functions', icon: 'gcp-cloud-functions' }],
	[/^google-github-actions\/get-gke-credentials/, { key: 'GKE', icon: 'gcp-gke' }],
	[/^google-github-actions\//, { key: 'Google Cloud', icon: 'gcp' }],
	[/^azure\/webapps-deploy/, { key: 'Azure App Service', icon: 'azure-app-service' }],
	[/^azure\/functions-action/, { key: 'Azure Functions', icon: 'azure-functions' }],
	[/^azure\/aks-set-context|^azure\/k8s-deploy/, { key: 'AKS', icon: 'azure-aks' }],
	[/^azure\/static-web-apps-deploy/, { key: 'Azure Static Web Apps', icon: 'azure-static-web-apps' }],
	[/^azure\//, { key: 'Azure', icon: 'azure' }],
	[/^docker\/build-push-action/, { key: 'Container registry', icon: 'docker' }],
	[/^amondnet\/vercel-action|^vercel\//, { key: 'Vercel', icon: 'vercel' }],
	[/^superfly\/flyctl-actions/, { key: 'Fly.io', icon: 'flyio' }],
	[/^netlify\/actions|^nwtgck\/actions-netlify/, { key: 'Netlify', icon: 'netlify' }],
	[/^cloudflare\/wrangler-action|^cloudflare\/pages-action/, { key: 'Cloudflare', icon: 'cloudflare' }],
	[/^hashicorp\/setup-terraform/, { key: 'Terraform', icon: 'terraform' }],
	[/^actions\/deploy-pages/, { key: 'GitHub Pages', icon: 'github' }],
	[/^pypa\/gh-action-pypi-publish/, { key: 'PyPI', icon: 'python' }],
	[/^helm\/|^azure\/setup-helm/, { key: 'Helm', icon: 'helm' }],
	[/^railwayapp\//, { key: 'Railway', icon: 'railway' }],
]

const RUNS: [RegExp, Target][] = [
	[/\bnpm publish\b|\bpnpm publish\b|\byarn npm publish\b|changeset publish/, { key: 'npm registry', icon: 'package' }],
	[/\bvercel (deploy|--prod)/, { key: 'Vercel', icon: 'vercel' }],
	[/\bflyctl deploy\b|\bfly deploy\b/, { key: 'Fly.io', icon: 'flyio' }],
	[/\bwrangler (deploy|publish)\b/, { key: 'Cloudflare', icon: 'cloudflare' }],
	[/\brailway up\b/, { key: 'Railway', icon: 'railway' }],
	[/\bkubectl apply\b|\bhelm upgrade\b/, { key: 'Kubernetes', icon: 'kubernetes' }],
	[/\bterraform apply\b/, { key: 'Terraform', icon: 'terraform' }],
	[/\bdocker push\b/, { key: 'Container registry', icon: 'docker' }],
	[/\bgcloud run deploy\b/, { key: 'Cloud Run', icon: 'gcp-cloud-run' }],
	[/\baws (s3 sync|ecs update-service|lambda update-function-code)/, { key: 'AWS', icon: 'aws' }],
	[/\btwine upload\b/, { key: 'PyPI', icon: 'python' }],
]

function triggers(on: unknown): string[] {
	if (typeof on === 'string') return [on]
	if (Array.isArray(on)) return on.map(String)
	return Object.keys(asObj(on))
}

export interface ActionsResult {
	page: ArchPage
	notes: string[]
	targets: string[]
}

export function analyzeActions(files: ScanFiles, pageName = 'CI/CD'): ActionsResult | null {
	const paths = [...files.keys()].filter((p) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(p)).sort()
	if (!paths.length) return null
	const keys = new KeyAllocator()
	const nodes: ArchNode[] = []
	const edges: ArchEdge[] = []
	const targetKey = new Map<string, string>()
	let jobsTotal = 0
	for (const path of paths) {
		// GitHub's `on:` parses as boolean true in YAML 1.1; the yaml lib (1.2) keeps it as "on"
		const doc = asObj(parseYaml(files.get(path) ?? ''))
		const jobs = asObj(doc.jobs)
		if (!Object.keys(jobs).length) continue
		const name = asStr(doc.name) ?? basename(path).replace(/\.ya?ml$/, '')
		const on = triggers(doc.on ?? doc.true)
		const g = keys.take(`${name} workflow`)
		nodes.push({ key: g, label: on.length ? `${name} (${on.slice(0, 3).join(', ')})` : name, role: 'group', isContainer: true, icon: 'github-actions' })
		const jobKey = new Map<string, string>()
		for (const [id, raw] of Object.entries(jobs)) {
			const k = keys.take(`${name} ${id}`)
			jobKey.set(id, k)
			const job = asObj(raw)
			const uses = asStr(job.uses) // reusable workflow
			nodes.push({ key: k, label: asStr(job.name) ?? id, parent: g, role: 'service', icon: uses ? 'workflow' : 'ci' })
			jobsTotal++
		}
		for (const [id, raw] of Object.entries(jobs)) {
			const job = asObj(raw)
			const from = jobKey.get(id)!
			const needs = typeof job.needs === 'string' ? [job.needs] : asArr(job.needs).map(String)
			for (const n of needs) if (jobKey.has(n)) edges.push({ from: jobKey.get(n)!, to: from })
			const found = new Map<string, Target>()
			for (const step of asArr(job.steps)) {
				if (!isObj(step)) continue
				const u = asStr(step.uses)
				const run = asStr(step.run)
				const t = (u && USES.find(([re]) => re.test(u))?.[1]) || (run && RUNS.find(([re]) => re.test(run))?.[1])
				if (t) found.set(t.key, t)
				if (u?.startsWith('docker/login-action')) {
					const reg = asStr(asObj(step.with).registry)
					if (reg?.includes('ghcr.io')) found.set('GHCR', { key: 'GHCR', icon: 'github' })
				}
			}
			if (found.has('GHCR')) found.delete('Container registry')
			for (const t of found.values()) {
				if (!targetKey.has(t.key)) {
					const k = keys.take(t.key)
					targetKey.set(t.key, k)
					nodes.push({ key: k, icon: t.icon, role: 'external' })
				}
				edges.push({ from, to: targetKey.get(t.key)!, label: 'deploy' })
			}
		}
	}
	if (!nodes.length) return null
	return {
		page: { name: pageName, analyzer: 'code', nodes, edges },
		notes: [`${plural(paths.length, 'workflow')}, ${plural(jobsTotal, 'job')}${targetKey.size ? `, deploys to ${[...targetKey.keys()].join(', ')}` : ''}`],
		targets: [...targetKey.keys()],
	}
}
