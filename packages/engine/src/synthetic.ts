/**
 * Deterministic synthetic architecture diagram: `n` leaves spread over groups nested two deep,
 * ~1.3 edges per node, mostly between neighbouring groups. Shared with the browser test page.
 */
export function syntheticOcto(n: number, seed = 7): string {
	let s = seed
	const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648)
	const groups = Math.max(2, Math.round(n / 8))
	const icons = ['server', 'database', 'cpu', 'zap', 'radio', 'globe', 'box', 'shield']
	const lines = ['title Synthetic ' + n, 'direction right']
	const leaves: string[] = []
	for (let g = 0; g < groups; g++) {
		lines.push(`Group ${g} {`)
		const sub = g % 3 === 0
		if (sub) lines.push(`\tSub ${g} {`)
		const count = Math.floor(n / groups) + (g < n % groups ? 1 : 0)
		for (let i = 0; i < count; i++) {
			const key = `N${leaves.length}`
			leaves.push(key)
			lines.push(`${sub ? '\t\t' : '\t'}${key} [icon: ${icons[leaves.length % icons.length]}]`)
		}
		if (sub) lines.push('\t}')
		lines.push('}')
	}
	const edges = Math.round(n * 1.3)
	for (let i = 0; i < edges; i++) {
		const a = Math.floor(rnd() * n)
		const span = 1 + Math.floor(rnd() * 12)
		const b = Math.min(n - 1, a + span)
		if (a !== b) lines.push(`${leaves[a]} > ${leaves[b]}`)
	}
	return lines.join('\n')
}
