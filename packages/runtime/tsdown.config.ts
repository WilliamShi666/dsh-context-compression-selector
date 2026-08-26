import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    invariant: 'src/invariant.ts',
  },
  format: 'esm',
  dts: true,
  clean: true,
  outDir: 'lib',
  fixedExtension: false,
  hash: false,
  sourcemap: false,
  deps: { neverBundle: true },
})
