/**
 * Runtime-only import for node SDKs and builtins. The specifier is a variable,
 * so bundlers (Vite) leave it alone: browser builds of `@octo-draw/scan` never
 * pull in the AWS / Google / Azure SDKs, which only load for live scans.
 */
export function importModule(name: string): Promise<Record<string, unknown>> {
	return import(/* @vite-ignore */ name) as Promise<Record<string, unknown>>
}
