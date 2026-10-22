export * from './ir'
export * from './agent'
export { parseOcto } from './dsl/parse'
export { printOcto } from './dsl/print'
export { setNodeProp, setEdgeProp, renameNodeLabel } from './dsl/patch'
export { parseMermaid } from './mermaid/parse'
export { toMermaid } from './mermaid/print'
export { parseAscii } from './ascii/parse'
export { detectFormat, importText, type TextFormat } from './import/detect'
export { layoutDiagram } from './layout/layout'
export { applyActions } from './agent/apply'
export * from './free'
export * from './doc'
export { renderDiagramSvg, renderDocumentSvg, contentBounds, type RenderSvgOptions, type IconNode, type IconResolver } from './render/svg'
export type { RenderTheme } from './render/colors'
export { fromTldrawSnapshot, toTldrawSnapshot, isTldrawSnapshot, TLDRAW_SCHEMA, type TldrawSnapshot, type TldrawRecord, type FromTldrawOptions, type ToTldrawOptions } from './interop/tldraw'
export { ICON_ALIASES, iconCandidates } from './render/iconAliases'
export {
	resolveIcon,
	searchIcons,
	iconSvg,
	iconInnerSvg,
	iconPaint,
	iconColor,
	badgeBox,
	ICON_NAMES,
	ICON_ALL_NAMES,
	CATALOG as ICON_CATALOG,
	type ResolvedIcon,
	type IconElement,
	type IconSearchHit,
	type IconSvgOptions,
	type CatalogEntry as IconCatalogEntry,
	type IconVendor,
} from './icons'
