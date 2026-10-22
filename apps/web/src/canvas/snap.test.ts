import { describe, expect, it } from 'vitest'
import { resizeBox, snapMove, snapResize } from './snap'

describe('resizeBox', () => {
	const start = { x: 0, y: 0, w: 100, h: 50 }
	it('moves only the dragged edges', () => {
		expect(resizeBox(start, 'se', 20, 10, false)).toEqual({ x: 0, y: 0, w: 120, h: 60 })
		expect(resizeBox(start, 'nw', 20, 10, false)).toEqual({ x: 20, y: 10, w: 80, h: 40 })
		expect(resizeBox(start, 'e', 20, 99, false)).toEqual({ x: 0, y: 0, w: 120, h: 50 })
	})
	it('keeps aspect with shift', () => {
		const b = resizeBox(start, 'se', 100, 0, true)
		expect(b.w / b.h).toBeCloseTo(2)
		expect(b.w).toBe(200)
	})
	it('flips past the opposite edge', () => {
		expect(resizeBox(start, 'e', -150, 0, false)).toEqual({ x: -50, y: 0, w: 50, h: 50 })
	})
})

describe('snapping', () => {
	const target = { x: 200, y: 100, w: 50, h: 50 }
	it('snaps a moving box to a target edge and reports a guide', () => {
		const r = snapMove({ x: 0, y: 97, w: 40, h: 40 }, [target], 6)
		expect(r.dy).toBe(3)
		expect(r.guides.some((g) => g.axis === 'y' && g.at === 100)).toBe(true)
	})
	it('ignores far targets', () => {
		expect(snapMove({ x: 0, y: 50, w: 40, h: 20 }, [target], 6).dy).toBe(0)
	})
	it('snaps only moving edges on resize', () => {
		const r = snapResize({ x: 0, y: 0, w: 197, h: 148 }, 'se', [target], 6)
		expect(r.box).toEqual({ x: 0, y: 0, w: 200, h: 150 })
	})
})
