// packages/shared/src/env.ts — Re-export from src/lib/env.ts
// In the monorepo, this is the single source of truth for env validation.
// During the transition, it re-exports from the existing src/lib/env.ts.
// After Phase 4, this file will contain the actual Zod schema.

export { envSchema, validateEnv, getEnv, type Env } from '../../src/lib/env';
