// [LAW:single-enforcer] Ambient declaration of secrets that exist at runtime
// but are not codegened by `wrangler types` (because secrets aren't in
// wrangler.toml). The `env` import from `cloudflare:workers` is typed as
// `Cloudflare.Env` (see worker-configuration.d.ts) — so secrets are merged
// into that namespace, not the top-level `Env`.
declare namespace Cloudflare {
  interface Env {
    readonly FIRECRAWL_API_KEY?: string;
    // [LAW:single-enforcer] Auth gate password for the admin surface. Absent in
    // dev (passthrough); set via `wrangler secret put ADMIN_SECRET` in production.
    readonly ADMIN_SECRET?: string;
    // [LAW:single-enforcer] DeepSeek API token for on-demand summarization (the
    // app's first LLM effect, quarantined in summary.ts). Absent => summarize
    // returns configured:false rather than crashing; set via
    // `wrangler secret put DEEPSEEK_API_TOKEN` in production.
    readonly DEEPSEEK_API_TOKEN?: string;
  }
}
