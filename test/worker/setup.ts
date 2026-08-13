import { applyD1Migrations, env } from 'cloudflare:test';

// Runs once in the outermost storage frame, so the schema survives the
// per-test isolation that rolls back everything else.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
