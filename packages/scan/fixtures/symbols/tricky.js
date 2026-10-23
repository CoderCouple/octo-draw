import { real } from './real.js'
const fake = `import { nope } from './nope'`
const nested = `outer ${`inner ${real(1)} ${'str }'}`} done`
// import { commented } from './commented'
/* import x from './block' */
const re1 = /['"]/g
const re2 = /\/\/ not a comment/
const re3 = /[/]{2}/
const div = 10 / 2 / 1
const quote = "it's \"fine\" // not a comment"

export function useAll() {
	const r = re1.test(quote) && re2.test(fake)
	return r ? helper(div) : nested.replace(/x/g, '}')
}

function helper(n) {
	if (n > 2) return n / 2
	return /=/.test(String(n)) ? re3 : useAll
}

const lazy = () => import('./lazy.js')
const cfg = require('./config')
const { a, b: bee } = require('./ab')
export const tpl = (s) => `${s}`
