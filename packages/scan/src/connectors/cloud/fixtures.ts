/** Test helpers: load the hand-written fixtures under `packages/scan/fixtures/cloud/`. Test-only (node). */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

export const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../../fixtures/cloud')

export function fixturePath(rel: string): string {
	return join(FIXTURES, rel)
}

export function fixture(rel: string): unknown {
	return JSON.parse(readFileSync(fixturePath(rel), 'utf8'))
}

export function fixtureText(rel: string): string {
	return readFileSync(fixturePath(rel), 'utf8')
}

/** Strings planted in the fixtures that must never reach any output. */
export const PLANTED_SECRETS = [
	'tok_live_9f8e7d6c5b4a3210',
	'hunter2',
	's3cr3t-pass',
	'very-secret-session-value',
	'tagged-secret-oops',
	'ops-oncall@example.com',
	'never-read-this',
	'config-snapshot-secret',
	'ghp_tagvalueshouldvanish',
	'gcp-session-secret-value',
	'SG.not-a-real-key',
	'receipts@acme.example',
	'P@ssw0rd-in-a-tag',
	'AccountKey=abc',
	'00000000-aaaa-bbbb-cccc-000000000000',
	'LS0tLS1CRUdJTi',
]
