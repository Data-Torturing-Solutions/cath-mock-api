import { defineConfig } from 'vitest/config';

/**
 * Node-side tests: the generator, schema validation and the pure contract
 * helpers. Ajv compiles validators with `new Function`, which workerd blocks,
 * so schema conformance is asserted here rather than inside the Worker pool.
 */
export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts'],
    environment: 'node',
    globals: true,
    testTimeout: 30_000,
  },
});
