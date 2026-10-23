import { describe, expect, it } from 'vitest'
import { AWS_READ_OPERATIONS, AWS_SDK_CLIENTS, defaultAwsApi, type AwsService } from './aws/collect'
import { importModule } from './lazy'

// Loads the real SDK modules and checks the wiring. Nothing is sent: no client is
// asked to resolve credentials or make a request.
describe('SDK wiring (no requests)', () => {
	it('every allowlisted AWS operation has a client and a Command class in its package', async () => {
		for (const [service, ops] of Object.entries(AWS_READ_OPERATIONS) as [AwsService, readonly string[]][]) {
			const spec = AWS_SDK_CLIENTS[service]
			const mod = await spec.load()
			expect(typeof mod[spec.client], `${service} ${spec.client}`).toBe('function')
			for (const op of ops) expect(typeof mod[`${op}Command`], `${service}:${op}`).toBe('function')
		}
	}, 60_000)

	it('builds the default AWS API lazily and still refuses writes', async () => {
		const api = await defaultAwsApi({ profile: 'octo-test-profile-that-does-not-exist' })
		await expect(api.call('lambda', 'us-east-1', 'InvokeFunction', {})).rejects.toThrow(/refusing/)
	})

	it('Google and Azure auth packages expose what the collectors use', async () => {
		expect(typeof (await importModule('google-auth-library')).GoogleAuth).toBe('function')
		expect(typeof (await importModule('@azure/identity')).DefaultAzureCredential).toBe('function')
	})
})
