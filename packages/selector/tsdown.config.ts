import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    invariant: 'src/invariant.ts',
    // This ESM face supplies client.d.ts. The sequential client build then
    // overwrites only client.js with the Harness lazy-CJS artifact.
    client: 'src/client/index.ts',
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
