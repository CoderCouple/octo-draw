/** Vite / vitest `?raw` imports of text fixtures (tests only). */
declare module '*.octo?raw' {
	const text: string
	export default text
}
