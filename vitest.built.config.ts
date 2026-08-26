import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['packages/selector/tests/built/**/*.spec.ts'],
    passWithNoTests: false,
  },
})
