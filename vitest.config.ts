import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  test: {
    passWithNoTests: false,
    projects: [
      {
        test: {
          name: 'runtime',
          environment: 'node',
          include: ['packages/runtime/tests/**/*.spec.ts'],
        },
      },
      {
        test: {
          name: 'selector-host',
          environment: 'node',
          include: [
            'packages/selector/tests/cache-prefix-audit.spec.ts',
            'packages/selector/tests/**/*.host.spec.ts',
          ],
        },
      },
      {
        resolve: {
          alias: {
            '@deepseek-ai/dsh-client-ui-primitives': fileURLToPath(new URL(
              './packages/selector/tests/support/ui-primitives.tsx',
              import.meta.url,
            )),
          },
        },
        test: {
          name: 'selector-client',
          environment: 'jsdom',
          include: ['packages/selector/tests/**/*.client.spec.{ts,tsx}'],
        },
      },
    ],
  },
})
