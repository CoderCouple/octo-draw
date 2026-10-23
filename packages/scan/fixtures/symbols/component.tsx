import React, { useState } from 'react'
import { Button } from './Button'
import { formatName } from './format'

interface Props {
	name: string
}

const identity = <T,>(x: T): T => x
const pick = <K extends keyof Props>(k: K) => k

export function Greeting({ name }: Props) {
	const [count, setCount] = useState(0)
	return (
		<div className="greeting" data-x='y'>
			<h1>Don't panic, {formatName(name)}!</h1>
			{/* it's a comment: Hidden() */}
			<Button onClick={() => setCount(count + 1)} label={`clicked ${count} times`}>
				It's {count > 1 ? 'many' : "one"} — won't break
			</Button>
			<Icon.Star size={2} />
			<>
				<Badge value={identity(count)} />
			</>
		</div>
	)
}

function Badge(props: { value: number }) {
	return <span>{props.value / 2}</span>
}

const Icon = { Star: (p: { size: number }) => <i>{p.size}</i> }

export default function App() {
	return <Greeting name="you" />
}
