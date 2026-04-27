# Legacy

Retired components kept for reference only. **Do not run, do not import, do not apply.**

## Contents

### `engram-mcp/`
Older Deno/Edge-style MCP server (single-table `public.thoughts`, OpenAI-only
embeddings, no ontology). Superseded by `server.ts` at the repo root, which is
domain-aware (per-schema), ontology-driven, and uses Voyage with an OpenAI
fallback.

### `schema.sql`
Original v1 schema creating `public.thoughts` and a `match_thoughts()` RPC.
Superseded by `migrations/001_create_domain_schemas.sql` (per-domain schemas)
and `migrations/002_mempalace_features.sql`. The current server does not query
`public.thoughts`; applying this file to a fresh project will not produce a
working install.

## When to delete

Once the codebase has been on `migrations/00{1,2}_*.sql` for long enough to be
confident no one is depending on the legacy paths, this directory can be
removed in a single commit.
