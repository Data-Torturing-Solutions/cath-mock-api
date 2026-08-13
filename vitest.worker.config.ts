import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineWorkersConfig, readD1Migrations } from '@cloudflare/vitest-pool-workers/config';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The conformance suite runs against the real Worker with real D1 and R2
 * bindings in workerd -- not against mocks. A suite that passes here is
 * evidence the deployed endpoint behaves the same way.
 */
export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations(join(here, 'migrations'));

  return {
    test: {
      include: ['test/worker/**/*.test.ts'],
      setupFiles: ['./test/worker/setup.ts'],
      poolOptions: {
        workers: {
          singleWorker: true,
          // Per-test storage isolation stacks SQLite snapshots, which Windows
          // cannot unlink while workerd holds them open (EBUSY). Every test
          // here keys on a unique publicationId, so shared storage is safe.
          isolatedStorage: false,
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
        },
      },
    },
  };
});
