/**
 * tldraw v4+/v5 draw-segment point encoding, implemented from the format
 * description (not from tldraw code):
 *
 *   base64( first point as little-endian Float32 [x, y, (z)],
 *           then per point little-endian Float16 deltas [dx, dy, (dz)] )
 *
 * `dim` 3 (or absent) carries pressure z; `dim` 2 omits it (z = 0.5).
 */

export interface Vec3 {
	x: number
	y: number
	z: number
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const LOOKUP = new Uint8Array(128)
for (let i = 0; i < 64; i++) LOOKUP[B64.charCodeAt(i)] = i

export function bytesToBase64(bytes: Uint8Array): string {
	let out = ''
	let i = 0
	for (; i + 2 < bytes.length; i += 3) {
		const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]
		out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63]
	}
	const rest = bytes.length - i
	if (rest === 1) {
		const n = bytes[i] << 16
		out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + '=='
	} else if (rest === 2) {
		const n = (bytes[i] << 16) | (bytes[i + 1] << 8)
		out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + '='
	}
	return out
}

export function base64ToBytes(s: string): Uint8Array {
	const clean = s.replace(/=+$/, '')
	const out = new Uint8Array(Math.floor((clean.length * 3) / 4))
	let o = 0
	for (let i = 0; i < clean.length; i += 4) {
		const n =
			(LOOKUP[clean.charCodeAt(i)] << 18) |
			(LOOKUP[clean.charCodeAt(i + 1)] << 12) |
			((i + 2 < clean.length ? LOOKUP[clean.charCodeAt(i + 2)] : 0) << 6) |
			(i + 3 < clean.length ? LOOKUP[clean.charCodeAt(i + 3)] : 0)
		if (o < out.length) out[o++] = (n >> 16) & 255
		if (o < out.length) out[o++] = (n >> 8) & 255
		if (o < out.length) out[o++] = n & 255
	}
	return out
}

/** IEEE 754 half precision → number. */
export function halfToNumber(h: number): number {
	const sign = h & 0x8000 ? -1 : 1
	const exp = (h >> 10) & 0x1f
	const frac = h & 0x3ff
	if (exp === 0) return sign * frac * 2 ** -24
	if (exp === 31) return frac ? NaN : sign * Infinity
	return sign * (1 + frac / 1024) * 2 ** (exp - 15)
}

/** number → IEEE 754 half precision bits (round to nearest). */
export function numberToHalf(v: number): number {
	if (Number.isNaN(v)) return 0x7e00
	const sign = v < 0 || Object.is(v, -0) ? 0x8000 : 0
	v = Math.abs(v)
	if (v === 0) return sign
	if (!Number.isFinite(v) || v >= 65520) return sign | 0x7c00
	if (v < 2 ** -14) return sign | Math.round(v / 2 ** -24)
	let exp = Math.floor(Math.log2(v))
	let frac = Math.round((v / 2 ** exp - 1) * 1024)
	if (frac === 1024) {
		frac = 0
		exp++
	}
	if (exp + 15 >= 31) return sign | 0x7c00
	return sign | ((exp + 15) << 10) | frac
}

export function decodePoints(path: string, dim: 2 | 3 = 3): Vec3[] {
	const bytes = base64ToBytes(path)
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	const first = dim * 4
	if (bytes.length < first) return []
	let x = view.getFloat32(0, true)
	let y = view.getFloat32(4, true)
	let z = dim === 3 ? view.getFloat32(8, true) : 0.5
	const out: Vec3[] = [{ x, y, z }]
	const step = dim * 2
	for (let o = first; o + step <= bytes.length; o += step) {
		x += halfToNumber(view.getUint16(o, true))
		y += halfToNumber(view.getUint16(o + 2, true))
		if (dim === 3) z += halfToNumber(view.getUint16(o + 4, true))
		out.push({ x, y, z })
	}
	return out
}

export function encodePoints(points: Vec3[], dim: 2 | 3 = 3): string {
	if (!points.length) return ''
	const first = dim * 4
	const step = dim * 2
	const bytes = new Uint8Array(first + (points.length - 1) * step)
	const view = new DataView(bytes.buffer)
	const p0 = points[0]
	view.setFloat32(0, p0.x, true)
	view.setFloat32(4, p0.y, true)
	if (dim === 3) view.setFloat32(8, p0.z, true)
	// Accumulate decoded values so rounding error does not drift along the stroke.
	let x = view.getFloat32(0, true)
	let y = view.getFloat32(4, true)
	let z = dim === 3 ? view.getFloat32(8, true) : 0.5
	for (let i = 1; i < points.length; i++) {
		const o = first + (i - 1) * step
		const p = points[i]
		const hx = numberToHalf(p.x - x)
		const hy = numberToHalf(p.y - y)
		view.setUint16(o, hx, true)
		view.setUint16(o + 2, hy, true)
		x += halfToNumber(hx)
		y += halfToNumber(hy)
		if (dim === 3) {
			const hz = numberToHalf(p.z - z)
			view.setUint16(o + 4, hz, true)
			z += halfToNumber(hz)
		}
	}
	return bytesToBase64(bytes)
}
