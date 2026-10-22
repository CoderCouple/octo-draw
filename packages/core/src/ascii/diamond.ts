/**
 * ASCII decision diamonds as chat models draw them:
 *
 *        /\              +            /\
 *       /  \            / \          /  \
 *      / ok \          /   \        < ok? >
 *      \    /         < ok? >        \  /
 *       \  /           \   /          \/
 *        \/             \ /
 *                        +
 *
 * Returns each diamond as per-row left/right border columns, so the box
 * pipeline (borders, interior label, terminals) treats it like a box.
 */

export interface DiamondRows {
	top: number
	bottom: number
	lefts: number[]
	rights: number[]
}

const APEX = new Set([...'+^.*\'`'])
const LEFT_MID = new Set([...'<|+('])
const RIGHT_MID = new Set([...'>|+)'])

export function findDiamonds(g: string[][], at: (r: number, c: number) => string): DiamondRows[] {
	const out: DiamondRows[] = []
	const taken = new Set<string>()
	for (let r = 0; r < g.length; r++) {
		for (let c = 0; c < g[r].length; c++) {
			if (g[r][c] !== '/' || taken.has(`${r},${c}`)) continue
			// Top slope pair: `/\`, `/ \`, `/  \` (close together, nothing slanted between).
			let c2 = -1
			for (let k = c + 1; k <= c + 3; k++) {
				const ch = at(r, k)
				if (ch === '\\') {
					c2 = k
					break
				}
				if (ch !== ' ') break
			}
			if (c2 < 0) continue
			const d = trace(r, c, c2)
			if (!d) continue
			out.push(d)
			for (let i = 0; i <= d.bottom - d.top; i++) taken.add(`${d.top + i},${d.lefts[i]}`)
		}
	}
	return out

	function trace(r: number, c: number, c2: number): DiamondRows | null {
		const lefts: number[] = []
		const rights: number[] = []
		let top = r
		const mid = Math.floor((c + c2) / 2)
		if (c2 - c >= 2 && APEX.has(at(r - 1, mid)) && at(r - 1, mid - 1) === ' ' && at(r - 1, mid + 1) === ' ') {
			top = r - 1
			lefts.push(mid)
			rights.push(mid)
		}
		lefts.push(c)
		rights.push(c2)
		let l = c
		let rr = c2
		let phase: 'expand' | 'mid' | 'contract' = 'expand'
		let expands = 0
		let contracts = 0
		let widest = rr - l
		for (let row = r + 1; row < g.length; row++) {
			if (phase === 'expand' && at(row, l - 1) === '/' && at(row, rr + 1) === '\\') {
				l--
				rr++
				expands++
			} else if (phase !== 'contract' && pickMid(row, l, rr)) {
				const m = pickMid(row, l, rr)!
				l = m[0]
				rr = m[1]
				phase = 'mid'
			} else {
				// After a `< label >` row the slopes may start a few columns inside it.
				const reach = phase === 'mid' ? 3 : 1
				const lc = span(l, l + reach).find((x) => at(row, x) === '\\')
				const rc = span(rr, rr - reach).find((x) => at(row, x) === '/')
				if (lc !== undefined && rc !== undefined && rc > lc) {
					l = lc
					rr = rc
					phase = 'contract'
					contracts++
				} else if (phase === 'contract' && rr - l <= 3) {
					// Optional bottom apex: `+`, `v`, `'`.
					const m = Math.floor((l + rr) / 2)
					if (APEX.has(at(row, m)) && at(row, m - 1) === ' ' && at(row, m + 1) === ' ') {
						lefts.push(m)
						rights.push(m)
						return done(row)
					}
					return done(row - 1)
				} else return null
			}
			lefts.push(l)
			rights.push(rr)
			widest = Math.max(widest, rr - l)
			if (phase === 'contract' && rr - l <= 1) return done(row)
		}
		return phase === 'contract' && rr - l <= 3 ? done(g.length - 1) : null

		function done(bottom: number): DiamondRows | null {
			const rows = bottom - top + 1
			if (contracts < 1 || widest < 4 || rows < 3) return null
			if (expands < 1 && phase !== 'contract') return null
			return { top, bottom, lefts: lefts.slice(0, rows), rights: rights.slice(0, rows) }
		}
	}

	function pickMid(row: number, l: number, rr: number): [number, number] | null {
		// The widest row is often wider than the slopes suggest: `< Paid? >`.
		for (const a of [l - 1, l, l - 2, l - 3]) {
			if (!LEFT_MID.has(at(row, a))) continue
			for (const b of [rr + 1, rr, rr + 2, rr + 3]) if (RIGHT_MID.has(at(row, b)) && b - a >= 3) return [a, b]
		}
		return null
	}

	function span(from: number, to: number): number[] {
		const out: number[] = []
		const step = to >= from ? 1 : -1
		for (let x = from; x !== to + step; x += step) out.push(x)
		return out
	}
}
