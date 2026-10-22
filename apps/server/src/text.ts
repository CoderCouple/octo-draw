/** Remove markdown code fences the model may wrap around code. */
export function stripFences(text: string): string {
	let t = text.trim()
	// A fenced block anywhere: take the first one's body.
	const m = t.match(/```[\w-]*[^\S\n]*\n([\s\S]*?)\n?```/)
	if (m) return m[1].trim()
	// Unterminated opening fence (e.g. truncated output).
	t = t.replace(/^```[\w-]*[^\S\n]*\n?/, '')
	t = t.replace(/\n?```\s*$/, '')
	return t.trim()
}

/**
 * Streaming variant: feed deltas, get back text that is safe to show live,
 * with an opening ```lang line and a closing ``` removed.
 */
export class FenceFilter {
	private started = false
	private head = ''
	private tail = ''
	private closed = false

	push(delta: string): string {
		if (this.closed) return ''
		if (!this.started) {
			this.head += delta
			const trimmed = this.head.replace(/^\s+/, '')
			if (trimmed === '' || ('```'.startsWith(trimmed) && trimmed.length < 3)) return ''
			if (trimmed.startsWith('```')) {
				const nl = trimmed.indexOf('\n')
				if (nl === -1) return ''
				this.started = true
				return this.emit(trimmed.slice(nl + 1))
			}
			this.started = true
			return this.emit(trimmed)
		}
		return this.emit(delta)
	}

	/** Call at the end; returns any held-back text. */
	flush(): string {
		if (!this.started) {
			this.started = true
			const t = this.head.trim()
			return t.startsWith('```') ? '' : t
		}
		const t = this.tail
		this.tail = ''
		if (this.closed) return ''
		return !this.midLine && /^\s*```/.test(t) ? '' : t
	}

	private midLine = false

	private emit(text: string): string {
		this.tail += text
		let out = ''
		let nl: number
		while ((nl = this.tail.indexOf('\n')) !== -1) {
			const line = this.tail.slice(0, nl + 1)
			this.tail = this.tail.slice(nl + 1)
			if (!this.midLine && /^\s*```/.test(line)) {
				this.closed = true
				this.tail = ''
				return out
			}
			out += line
			this.midLine = false
		}
		// Partial line: emit now unless it could still become a closing fence.
		if (this.tail && (this.midLine || !/^\s*`/.test(this.tail))) {
			out += this.tail
			this.tail = ''
			this.midLine = true
		}
		return out
	}
}
