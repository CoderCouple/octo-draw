import { createElement } from 'react'
import type { IconNode } from '../lib/icons'

/** Renders a statically imported lucide icon node (tree-shaken) for UI chrome. */
export function Icon({ icon, size = 16, strokeWidth = 1.8, className }: { icon: unknown; size?: number; strokeWidth?: number; className?: string }) {
	return (
		<svg
			className={className}
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth={strokeWidth}
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			{(icon as IconNode).map(([tag, attrs], i) => createElement(tag, { key: i, ...attrs }))}
		</svg>
	)
}
