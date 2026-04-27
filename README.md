# Engram

A domain-partitioned personal knowledge system with semantic search, ontology-driven classification, and privacy by design.

## What it is

Engram is a long-term memory layer for AI assistants. It captures, classifies, and retrieves knowledge from every source in your digital life: meetings, emails, Slack, calendars, research, and manual input. Your AI assistant searches it by meaning, not keywords.

## Architecture

Four isolated knowledge domains, each backed by its own Supabase schema:

| Domain | Purpose | Sensitivity | Examples |
|--------|---------|-------------|----------|
| **Work** | Professional context | Internal | Meeting notes, project decisions, colleague observations |
| **Personal** | Family, relationships, finances | Confidential/Secret | Financial records, private contacts |
| **Life** | Health, goals, beliefs | Confidential | Personal development, health data, values |
| **Learning** | Skills, research, patterns | Public | Extracted wisdom, research summaries, reference material |

Domains are MECE (mutually exclusive, collectively exhaustive). Every piece of knowledge belongs to exactly one.

## Capabilities

- **Semantic search** using vector embeddings (Voyage AI / OpenAI, 1024d)
- **Auto-classification** via gpt-4o-mini with ontology inference rules
- **Cross-domain synapse**: work can see learning; personal/financial/psychological never leaks
- **17+ entity types** with default domain and sensitivity routing
- **Inference rules** that override defaults based on people, topics, content, source
- **Self-evolving ontology**: classifier detects gaps and writes proposals for human review
- **MCP interface**: `search_thoughts`, `list_thoughts`, `capture_thought`, `thought_stats`, `situational_awareness`, `project_status`

## Data sources

| Source | Target | Sync |
|--------|--------|------|
| Notion meeting transcripts | work | Automated (launchd) |
| Exchange email (AppleScript) | work | Automated |
| macOS Calendar (EventKit) | work | Automated |
| Slack | work | Automated |
| Session transcripts | learning | Automated |
| Context backups (git diff) | learning | Automated |
| Manual captures | Auto-classified | Via MCP |

## Privacy model

Four sensitivity levels: public, internal, confidential, secret. Financial records and psychological profiles are "secret" and locked to their domain. A `never_cross` list blocks the most sensitive types from crossing domain boundaries unconditionally.

## Tech stack

- **Storage**: Supabase (PostgreSQL + pgvector)
- **Search**: HNSW vector indexes, cosine similarity
- **Interface**: MCP server (Bun + @modelcontextprotocol/sdk)
- **Classification**: gpt-4o-mini with ontology context
- **Embeddings**: Voyage AI (voyage-3), OpenAI fallback (text-embedding-3-small)
- **Ontology**: YAML, versioned, evolution proposals tracked in DB

## Setup

### 1. Supabase

1. Create a [Supabase](https://supabase.com) project
2. Apply the SQL migrations. From this repo, with `DATABASE_URL` set to your project's postgres connection string (Project Settings → Database → Connection string → URI):

   ```bash
   bun run apply-migrations.ts            # apply all pending
   bun run apply-migrations.ts --status   # show applied vs pending
   bun run apply-migrations.ts --dry-run  # plan without applying
   ```

   The script tracks applied migrations in `public.engram_migrations` and refuses to run if a previously-applied migration's content has drifted on disk. You can still run files manually in the Supabase SQL Editor if you prefer.

3. In Settings > API > Exposed schemas, add: `ob_work`, `ob_personal`, `ob_life`, `ob_learning`

### 2. Environment

```bash
cp .env.example .env
# Fill in your Supabase URL, service role key, and API keys
```

### 3. Install & run

```bash
bun install
bun run server.ts
```

### 4. MCP integration (Claude Code)

Add to your `~/.claude.json`:

```json
{
  "mcpServers": {
    "engram": {
      "command": "bun",
      "args": ["run", "/path/to/engram/server.ts"],
      "env": {
        "SUPABASE_URL": "https://your-project.supabase.co",
        "SUPABASE_SERVICE_ROLE_KEY": "your-key",
        "OPENAI_API_KEY": "your-key",
        "VOYAGE_API_KEY": "your-key"
      }
    }
  }
}
```

### 5. Sync scripts

```bash
# Meeting transcripts from Notion
bun run sync-notion-meetings.ts

# Email from Apple Mail (Exchange)
bun run sync-email.ts

# Calendar events via EventKit
bun run sync-calendar.ts

# Slack messages
bun run sync-slack.ts

# Session transcripts
bun run sync-sessions.ts

# PAI context backup (git diff)
bun run sync-pai-context.ts
```

Set these up as launchd jobs for automated daily sync. See `run-meeting-sync.sh` for an example orchestration script.

## Files

```
server.ts                    # MCP server v2.0.0
ontology/v1.0.0.yaml         # Knowledge graph definition (example)
ontology/v1.1.0.yaml         # Extended ontology with project artifacts
migrations/001_*.sql          # Schema creation + data migration
sync-notion-meetings.ts       # Notion transcripts -> work
sync-email.ts                 # Exchange email -> work
sync-calendar.ts              # Calendar -> work
sync-slack.ts                 # Slack -> work
sync-sessions.ts              # Session transcripts -> learning
sync-pai-context.ts           # Context backups -> learning
pull-engram.ts             # Bidirectional sync (pull external thoughts)
enrich-notion-meetings.ts     # Fill Notion DB properties from transcripts
```

## License

MIT
