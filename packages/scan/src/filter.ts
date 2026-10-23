/**
 * Which files a scan reads (pure; shared by the fs walker and remote connectors).
 * Skips dependency / build / VCS directories, secrets (`.env*`, keys, tfvars,
 * state), lockfiles and non-text files.
 */

/** Directories never descended into (gitignore-style defaults). */
export const SKIP_DIRS = new Set([
	'node_modules', 'dist', '.git', 'vendor', 'build', 'out', '.next', '.nuxt', '.svelte-kit', '.turbo', '.vercel', '.output', '.cache', '.parcel-cache',
	'coverage', '.nyc_output', 'target', '__pycache__', '.venv', 'venv', '.tox', '.mypy_cache', '.pytest_cache', '.terraform', '.gradle', '.idea', '.vscode',
	'fixtures', '__fixtures__', 'testdata', '__snapshots__', 'bower_components', 'jspm_packages', '.yarn', '.pnpm-store', 'tmp', '.tmp', '.expo', '.angular', 'storybook-static', 'site-packages', 'Pods', 'DerivedData',
])

const TEXT_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|vue|svelte|json|ya?ml|toml|tf|go|mod|work|py|rs|md|txt|cfg|ini|gradle|kt|java|rb|php|cs|graphql|proto|sql|hcl)$/i
const TEXT_NAMES = /^(Dockerfile|Containerfile|Makefile|Procfile|go\.mod|go\.work|Cargo\.toml|Gemfile|requirements[\w.-]*\.txt|Pipfile)$|^Dockerfile\./
/** Never read: secrets and lockfiles. */
const DENY = /^\.env(\..*)?$|\.(pem|key|p12|pfx|crt|cer|jks|keystore|tfvars|tfstate|tfstate\.backup|lock|min\.js|map)$|^(id_rsa|id_ed25519|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb|Cargo\.lock|poetry\.lock|go\.sum|credentials(\.json)?|secrets?\.(ya?ml|json))$/i

/** Is this file name one the analyzers can use (text, not a secret or lockfile)? */
export function isScannable(name: string): boolean {
	if (DENY.test(name)) return false
	return TEXT_EXT.test(name) || TEXT_NAMES.test(name)
}

/** Should a directory with this name be skipped? Hidden dirs are skipped except `.github`. */
export function skipDir(name: string): boolean {
	return SKIP_DIRS.has(name) || (name.startsWith('.') && name !== '.github')
}

/** Repo-relative path check: every directory segment allowed and the file scannable. */
export function isScannablePath(path: string): boolean {
	const parts = path.split('/')
	const name = parts.pop()!
	return parts.every((p) => !skipDir(p)) && isScannable(name)
}

/**
 * Fetch priority for remote sources with a file budget: manifests and infra
 * first (0), then entry/config files (1), source code (2), docs and the rest (3).
 */
export function filePriority(path: string): number {
	const name = path.slice(path.lastIndexOf('/') + 1)
	if (/^(package\.json|pnpm-workspace\.yaml|go\.mod|go\.work|Cargo\.toml|pyproject\.toml|setup\.py|requirements[\w.-]*\.txt|Dockerfile|Containerfile)$/.test(name)) return 0
	if (/(^|\/)(docker-)?compose(\.[\w-]+)?\.ya?ml$/.test(path) || /\.tf$/.test(name) || /^\.github\/workflows\//.test(path)) return 0
	if (/\.(ya?ml)$/.test(name) || /^(ts|js)config(\.[\w-]+)?\.json$/.test(name) || /(openapi|swagger)/i.test(name) || /\.config\.[cm]?[jt]s$/.test(name)) return 1
	if (/\.(m|c)?(t|j)sx?$|\.(go|py|rs|vue|svelte)$/.test(name)) return 2
	return 3
}
