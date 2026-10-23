/**
 * Pure pipeline: export JSON → provider detection → CloudGraph → octo DSL.
 * No SDKs, no I/O; safe in the browser and in tests.
 */

import { kindOrFallback } from './catalog'
import { bypassHidden, ACCOUNT_TYPE, REGION_TYPE, type CloudGraph, type CloudProvider } from './model'
import { renderCloudGraph, type RenderOptions, type RenderResult } from './render'
import { looksLikeAws, normalizeAws, type AwsNormalizeOptions } from './aws/normalize'
import { looksLikeGcp, normalizeGcp, type GcpNormalizeOptions } from './gcp/normalize'
import { looksLikeAzure, normalizeAzure, type AzureNormalizeOptions } from './azure/normalize'

/** Which provider produced this export? Azure and GCP shapes are checked first: they are the most specific. */
export function detectCloudExport(input: unknown): CloudProvider | null {
	if (looksLikeAzure(input)) return 'azure'
	if (looksLikeGcp(input)) return 'gcp'
	if (looksLikeAws(input)) return 'aws'
	return null
}

/** Parses export text: JSON, or newline-delimited JSON (exportAssets). */
export function parseExportText(text: string): unknown {
	const t = text.replace(/^﻿/, '').trim()
	try {
		return JSON.parse(t)
	} catch {
		const lines = t.split('\n').filter((l) => l.trim())
		const out: unknown[] = []
		for (const l of lines) {
			try {
				out.push(JSON.parse(l))
			} catch {
				return undefined
			}
		}
		return out.length ? out : undefined
	}
}

export type NormalizeOptions = AwsNormalizeOptions & GcpNormalizeOptions & AzureNormalizeOptions

export function normalizeCloud(provider: CloudProvider, input: unknown, opts: NormalizeOptions = {}): CloudGraph {
	const g = provider === 'aws' ? normalizeAws(input, opts) : provider === 'gcp' ? normalizeGcp(input, opts) : normalizeAzure(input, opts)
	return bypassHidden(g, (r) => r.type !== ACCOUNT_TYPE && r.type !== REGION_TYPE && !!kindOrFallback(r.type, provider).hidden)
}

export interface CloudToOctoResult extends RenderResult {
	provider: CloudProvider
	graph: CloudGraph
}

export function cloudExportToOcto(input: unknown, opts: NormalizeOptions & RenderOptions & { provider?: CloudProvider } = {}): CloudToOctoResult | null {
	const provider = opts.provider ?? detectCloudExport(input)
	if (!provider) return null
	const graph = normalizeCloud(provider, input, opts)
	return { provider, graph, ...renderCloudGraph(graph, opts) }
}
