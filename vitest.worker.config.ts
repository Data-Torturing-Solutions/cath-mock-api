import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The conformance suite runs against the real Worker with real D1 and R2
 * bindings in workerd -- not against mocks. A suite that passes here is
 * evidence the deployed endpoint behaves the same way.
 */
export default defineConfig(async () => {
  const migrations = await readD1Migrations(join(here, 'migrations'));

  return {
    // `isolatedStorage` / `singleWorker` no longer exist as of 0.21 -- storage
    // isolation is now per test file (matching Vitest's own model) rather than
    // per test. Every test here already keys on a unique publicationId, so
    // sharing storage within a file is safe either way.
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.receiver.toml' },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            // Test-only credentials. Production values come from
            // `wrangler secret put` and never appear in a config file.
            CATH_CLIENT_SECRET: 'test-client-secret',
            JWT_SIGNING_KEY: 'test-signing-key-not-for-production',
            ADMIN_TOKEN: 'test-admin-token',
          },
        },
      }),
    ],
    test: {
      include: ['test/worker/**/*.test.ts'],
      setupFiles: ['./test/worker/setup.ts'],
    },
  };
});
