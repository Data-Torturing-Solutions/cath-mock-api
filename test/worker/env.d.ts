import type { D1Migration } from '@cloudflare/vitest-pool-workers';
import type { Env as ReceiverEnv } from '../../src/receiver/env.js';

// As of 0.21, `cloudflare:test`'s `env` is typed via the ambient
// `Cloudflare.Env` namespace (the same one `wrangler types` generates into)
// rather than a `ProvidedEnv` interface on the `cloudflare:test` module.
//
// This file has top-level imports, which makes it a module -- so the
// namespace augmentation has to go through `declare global` explicitly, or
// it merges into a module-local `Cloudflare` that nothing else sees.
declare global {
  namespace Cloudflare {
    interface Env extends ReceiverEnv {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
