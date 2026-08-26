import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basename, dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'tsdown'
import { transform } from 'lightningcss'

const PLUGIN_ID = 'dsh-context-compression-selector'
const SELECTOR_ROOT = dirname(fileURLToPath(import.meta.url))
const CSS_PREFIX = '\0dsh-context-compression-css:'
const CSS_SUFFIX = '.mjs'
const CLIENT_EXTERNALS = new Set([
  'react',
  'react/jsx-runtime',
  '@deepseek-ai/dsh-client-ui-primitives',
])
const cssFiles = new Map<string, string>()

function stableCssFileId(file: string): string {
  const id = relative(SELECTOR_ROOT, file).replaceAll('\\', '/')
  if (id === '..' || id.startsWith('../')) {
    throw new Error(`CSS module is outside the selector package: ${id}`)
  }
  return id
}

function styleModule(file: string, css: string, classMap: Readonly<Record<string, string>>): string {
  const tagId = `${PLUGIN_ID}/${basename(file)}`
  return [
    `const css = ${JSON.stringify(css)};`,
    `const tagId = ${JSON.stringify(tagId)};`,
    'if (typeof document !== "undefined" && document.querySelector(`style[data-plugin-css="${tagId}"]`) === null) {',
    '  const tag = document.createElement("style");',
    `  tag.dataset.plugin = ${JSON.stringify(PLUGIN_ID)};`,
    '  tag.dataset.pluginCss = tagId;',
    '  tag.textContent = css;',
    '  document.head.appendChild(tag);',
    '}',
    `export default ${JSON.stringify(classMap)};`,
  ].join('\n')
}

export default defineConfig({
  name: `${PLUGIN_ID}/client`,
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2023',
  dts: false,
  clean: false,
  fixedExtension: false,
  hash: false,
  sourcemap: false,
  deps: {
    neverBundle: specifier => CLIENT_EXTERNALS.has(specifier),
    alwaysBundle: specifier => !CLIENT_EXTERNALS.has(specifier),
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
  },
  plugins: [{
    name: 'dsh-context-compression-css-inline',
    resolveId(source: string, importer: string | undefined) {
      if (!source.endsWith('.module.css')) return null
      const file = importer === undefined ? source : resolve(dirname(importer), source)
      const digest = createHash('sha256').update(stableCssFileId(file)).digest('hex').slice(0, 12)
      const id = `${CSS_PREFIX}${digest}-${basename(file)}${CSS_SUFFIX}`
      cssFiles.set(id, file)
      return id
    },
    async load(id: string) {
      const file = cssFiles.get(id)
      if (file === undefined) return null
      this.addWatchFile(file)
      const source = await readFile(file)
      const stableFile = stableCssFileId(file)
      const result = transform({
        // lightningcss includes filename in CSS Modules hashes. A package-
        // relative identity keeps reviewed tarballs byte-for-byte stable when
        // the repository is cloned or moved to a different absolute path.
        filename: stableFile,
        code: source,
        cssModules: { pattern: '[hash]_[local]' },
        minify: true,
      })
      const classMap: Record<string, string> = {}
      for (const [local, value] of Object.entries(result.exports ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
        classMap[local] = value.name
      }
      return styleModule(file, result.code.toString(), classMap)
    },
  }],
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    footer: 'return module.exports; } });',
  },
})
