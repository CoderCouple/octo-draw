/**
 * Display width of characters in chat-LLM text art. CJK and most emoji take
 * two terminal cells, but models often count them as one when they pad box
 * borders. The grid builder picks, per line, whichever variant lines its
 * vertical borders up with the neighbouring lines.
 */

const WIDE_RANGES: [number, number][] = [
	[0x1100, 0x115f],
	[0x231a, 0x231b],
	[0x2329, 0x232a],
	[0x23e9, 0x23ec],
	[0x23f0, 0x23f0],
	[0x23f3, 0x23f3],
	[0x25fd, 0x25fe],
	[0x2614, 0x2615],
	[0x2648, 0x2653],
	[0x267f, 0x267f],
	[0x2693, 0x2693],
	[0x26a1, 0x26a1],
	[0x26aa, 0x26ab],
	[0x26bd, 0x26be],
	[0x26c4, 0x26c5],
	[0x26ce, 0x26ce],
	[0x26d4, 0x26d4],
	[0x26ea, 0x26ea],
	[0x26f2, 0x26f3],
	[0x26f5, 0x26f5],
	[0x26fa, 0x26fa],
	[0x26fd, 0x26fd],
	[0x2705, 0x2705],
	[0x270a, 0x270b],
	[0x2728, 0x2728],
	[0x274c, 0x274c],
	[0x274e, 0x274e],
	[0x2753, 0x2755],
	[0x2757, 0x2757],
	[0x2795, 0x2797],
	[0x27b0, 0x27b0],
	[0x27bf, 0x27bf],
	[0x2b1b, 0x2b1c],
	[0x2b50, 0x2b50],
	[0x2b55, 0x2b55],
	[0x2e80, 0x303e],
	[0x3041, 0x33ff],
	[0x3400, 0x4dbf],
	[0x4e00, 0x9fff],
	[0xa000, 0xa4cf],
	[0xa960, 0xa97f],
	[0xac00, 0xd7a3],
	[0xf900, 0xfaff],
	[0xfe10, 0xfe19],
	[0xfe30, 0xfe6f],
	[0xff00, 0xff60],
	[0xffe0, 0xffe6],
	[0x1f004, 0x1f004],
	[0x1f0cf, 0x1f0cf],
	[0x1f18e, 0x1f18e],
	[0x1f191, 0x1f19a],
	[0x1f200, 0x1f2ff],
	[0x1f300, 0x1f64f],
	[0x1f680, 0x1f6ff],
	[0x1f7e0, 0x1f7eb],
	[0x1f90c, 0x1f9ff],
	[0x1fa70, 0x1faff],
	[0x20000, 0x3fffd],
]

export function isWide(cp: number): boolean {
	if (cp < 0x1100) return false
	let lo = 0
	let hi = WIDE_RANGES.length - 1
	while (lo <= hi) {
		const mid = (lo + hi) >> 1
		const [a, b] = WIDE_RANGES[mid]
		if (cp < a) hi = mid - 1
		else if (cp > b) lo = mid + 1
		else return true
	}
	return false
}

/** Placeholder occupying the second cell of a wide character. */
export const FILLER = '\u0000'

/** Display width of a string in terminal cells. */
export function displayWidth(s: string): number {
	let w = 0
	for (const ch of s) w += isWide(ch.codePointAt(0)!) ? 2 : 1
	return w
}

function toRow(line: string, wide: boolean): string[] {
	const row: string[] = []
	for (const ch of line) {
		row.push(ch)
		if (wide && isWide(ch.codePointAt(0)!)) row.push(FILLER)
	}
	return row
}

/** Characters that sit on a vertical border or line (used to compare alignment). */
const VERTICALISH = new Set([...'│┃║┆┇┊┋╎╏|┌┐└┘├┤┬┴┼╭╮╯╰╔╗╚╝╠╣╦╩╬┏┓┗┛┣┫+'])

function verticalCols(row: string[]): Set<number> {
	const s = new Set<number>()
	row.forEach((ch, i) => {
		if (VERTICALISH.has(ch)) s.add(i)
	})
	return s
}

/**
 * Builds the char grid. Lines without wide characters are identical in both
 * variants; for each line with wide characters, the variant whose vertical
 * glyphs match more columns of nearby lines wins (ties go to display width).
 */
export function buildGrid(lines: string[]): string[][] {
	const hasWide = lines.map((l) => {
		for (const ch of l) if (isWide(ch.codePointAt(0)!)) return true
		return false
	})
	const raw = lines.map((l) => toRow(l, false))
	const out = raw.slice()
	for (let i = 0; i < lines.length; i++) {
		if (!hasWide[i]) continue
		const wide = toRow(lines[i], true)
		const ref = new Map<number, number>()
		for (let d = 1; d <= 4; d++) {
			for (const j of [i - d, i + d]) {
				if (j < 0 || j >= lines.length || hasWide[j]) continue
				for (const c of verticalCols(raw[j])) ref.set(c, (ref.get(c) ?? 0) + 1 / d)
			}
		}
		const score = (row: string[]) => {
			let s = 0
			for (const c of verticalCols(row)) s += ref.get(c) ?? 0
			return s
		}
		out[i] = score(raw[i]) > score(wide) ? raw[i] : wide
	}
	return out
}
