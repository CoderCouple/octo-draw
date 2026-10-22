import { useSyncExternalStore } from 'react'
import type { Theme } from './colors'

export type ThemePref = 'system' | 'light' | 'dark'

const KEY = 'octo-draw:theme'
const listeners = new Set<() => void>()
const media = () => window.matchMedia('(prefers-color-scheme: dark)')

function readPref(): ThemePref {
	try {
		const v = localStorage.getItem(KEY)
		return v === 'light' || v === 'dark' ? v : 'system'
	} catch {
		return 'system'
	}
}

let pref: ThemePref = readPref()

/** `.dark` / `.light` on <html> force a theme; none follows the system (see styles.css). */
function applyClass() {
	const el = document.documentElement
	el.classList.toggle('dark', pref === 'dark')
	el.classList.toggle('light', pref === 'light')
}

applyClass()
media().addEventListener('change', () => listeners.forEach((l) => l()))

export function getThemePref() {
	return pref
}

export function setThemePref(next: ThemePref) {
	pref = next
	try {
		if (next === 'system') localStorage.removeItem(KEY)
		else localStorage.setItem(KEY, next)
	} catch {
		// storage unavailable
	}
	applyClass()
	listeners.forEach((l) => l())
}

export function currentTheme(): Theme {
	if (pref !== 'system') return pref
	return media().matches ? 'dark' : 'light'
}

function subscribe(cb: () => void) {
	listeners.add(cb)
	return () => listeners.delete(cb)
}

export function useTheme(): Theme {
	return useSyncExternalStore(subscribe, currentTheme, () => 'light')
}

export function useThemePref(): ThemePref {
	return useSyncExternalStore(subscribe, getThemePref, () => 'system')
}
