/**
 * @octo-draw/scan — source scanning to octo architecture diagrams.
 * Everything exported here is platform-free (runs in the browser on a
 * `showDirectoryPicker` folder); the file walker lives in `@octo-draw/scan/node`.
 */

export * from './types'
export { scanSource, emitGraph, safePageName, type ScanResult } from './scan'
export { graphToIR, emitOcto, type EmittedPage } from './emit'
export { analyzeCode, findWorkspaces, externalFor, EXTERNALS, type Workspace, type CodeMeta } from './analyzers/code'
export { analyzeCompose } from './analyzers/compose'
export { analyzeK8s } from './analyzers/k8s'
export { analyzeTerraform, iconForTerraformType, TERRAFORM_TYPE_ICONS } from './analyzers/terraform'
export { analyzeOpenApi } from './analyzers/openapi'
export { scanBlocks, attributes as hclAttributes } from './analyzers/hcl'
export { techFor, techForImage } from './tech'
export * from './connectors'
export { SKIP_DIRS, isScannable, isScannablePath, skipDir, filePriority } from './filter'
