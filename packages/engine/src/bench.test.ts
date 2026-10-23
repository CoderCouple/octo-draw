import { writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { benchCases, runBench, type BenchRow } from './bench'

// Router comparison (ELK vs Eraser corridor router). Prints a table; set BENCH_OUT to also
// write the rows as JSON. Runs in CI as a smoke test with one repeat.
describe('router bench', () => {
	it('routes every example page with both routers', async () => {
		const repeats = Number(process.env.BENCH_REPEATS ?? 1)
		const rows: BenchRow[] = []
		for (const c of benchCases()) rows.push(await runBench(c, repeats))
		const r = (n: number) => (Number.isFinite(n) ? n.toFixed(1) : '-')
		const lines = rows.map(
			(x) =>
				`${x.name.padEnd(22)} n=${String(x.nodes).padStart(3)} e=${String(x.edges).padStart(3)} | ` +
				`ELK bends ${x.elk.bends} cross ${x.elk.crossings} len ${x.elk.length} walls ${x.elk.wallCrossings}(+${x.elk.extraWallCrossings}) hits ${x.elk.nodeHits} diag ${x.elk.diagonals} ${r(x.elk.ms)}ms | ` +
				`ERASER bends ${x.eraser.bends} cross ${x.eraser.crossings} len ${x.eraser.length} walls ${x.eraser.wallCrossings}(+${x.eraser.extraWallCrossings}) hits ${x.eraser.nodeHits} fb ${x.eraser.fallback} ${r(x.eraser.ms)}ms det=${x.deterministic} | ` +
				`DRAG ${x.drag.node}: pins cross ${x.drag.elkPins.crossings} hits ${x.drag.elkPins.nodeHits} diag ${x.drag.elkPins.diagonals} ${r(x.drag.elkPins.ms)}ms; ` +
				`partial ${x.drag.eraserPartial.rerouted}/${x.drag.eraserPartial.rerouted + x.drag.eraserPartial.adopted} cross ${x.drag.eraserPartial.crossings} hits ${x.drag.eraserPartial.nodeHits} ${r(x.drag.eraserPartial.ms)}ms kept=${x.drag.eraserPartial.unchangedAdopted}; ` +
				`full cross ${x.drag.eraserFull.crossings} hits ${x.drag.eraserFull.nodeHits} ${r(x.drag.eraserFull.ms)}ms`,
		)
		console.log(lines.join('\n'))
		if (process.env.BENCH_OUT) writeFileSync(process.env.BENCH_OUT, JSON.stringify(rows, null, '\t'))
		for (const x of rows) {
			expect(x.eraser.edges).toBeGreaterThan(0)
			expect(x.deterministic).toBe(true)
			expect(x.drag.eraserPartial.unchangedAdopted).toBe(true)
		}
	}, 120_000)

	it.runIf(process.env.BENCH_SCALE)('scales to 50 and 200 nodes', async () => {
		const { appendFileSync } = await import('node:fs')
		const log = (line: string) => (process.env.BENCH_LOG ? appendFileSync(process.env.BENCH_LOG, line + '\n') : console.log(line))
		const { layoutDiagram, parseOcto } = await import('@octo-draw/core')
		const { routeEdges } = await import('./route')
		const { routeMetrics } = await import('./metrics')
		const { syntheticOcto } = await import('./bench')
		const out: string[] = []
		for (const n of [50, 200]) {
			const ir = parseOcto(syntheticOcto(n)).ir
			let t = performance.now()
			const layout = await layoutDiagram(ir)
			const elkMs = performance.now() - t
			const elk = routeMetrics(ir, layout)
			log(`n=${n} e=${ir.edges.length} ELK ${elkMs.toFixed(0)}ms cross ${elk.crossings} bends ${elk.bends} len ${elk.length} walls+${elk.extraWallCrossings}`)
			const variants: object[] = [{ repair: false }, { repairTimeBudgetMs: 100 }, { repairTimeBudgetMs: 1000 }]
			if (n <= 50) variants.push({})
			for (const o of variants) {
				t = performance.now()
				const res = routeEdges(layout, ir, o)
				const m = routeMetrics(ir, layout, res.edges)
				const fb = Object.values(res.status).filter((x) => x === 'fallback').length
				const line = `n=${n} eraser ${JSON.stringify(o)} ${res.ms.toFixed(0)}ms cross ${m.crossings} bends ${m.bends} len ${m.length} hits ${m.nodeHits} walls+${m.extraWallCrossings} fallback ${fb}`
				out.push(line)
				log(line)
			}
		}
		expect(out.length).toBe(7)
	}, 600_000)

	it('repair budget trade-off on the deep fixture', async () => {
		const { layoutDiagram } = await import('@octo-draw/core')
		const { routeEdges } = await import('./route')
		const { routeMetrics } = await import('./metrics')
		const c = benchCases().find((x) => x.name === 'deep')!
		const layout = await layoutDiagram(c.ir)
		const variants = [
			{ name: 'repair, budget Infinity', o: {} },
			{ name: 'repair, budget 100ms', o: { repairTimeBudgetMs: 100 } },
			{ name: 'repair, budget 20ms', o: { repairTimeBudgetMs: 20 } },
			{ name: 'no repair', o: { repair: false } },
			{ name: 'no repair, no labels', o: { repair: false, labels: false } },
		]
		const out: string[] = []
		for (const v of variants) {
			const res = routeEdges(layout, c.ir, v.o)
			const m = routeMetrics(c.ir, layout, res.edges)
			out.push(`${v.name.padEnd(24)} ${res.ms.toFixed(0)}ms bends ${m.bends} cross ${m.crossings} len ${m.length} hits ${m.nodeHits} extraWalls ${m.extraWallCrossings}`)
		}
		console.log(out.join('\n'))
		expect(out.length).toBe(variants.length)
	}, 120_000)
})
