/// <reference types="astro/client" />
/// <reference path="../worker-configuration.d.ts" />

// [LAW:types-are-the-program] The Env interface is generated from wrangler.toml
// by `wrangler types` — single source of truth for which bindings exist.
// Re-run `npx wrangler types` after editing wrangler.toml. For secrets, see
// src/secrets.d.ts which augments Env with FIRECRAWL_API_KEY (and any future
// secrets) via script-context interface merge.
