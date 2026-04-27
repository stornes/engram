# Engram architectural analysis

## Overview

Engram is a personal knowledge platform built around **Supabase + pgvector**, with **Bun-based MCP serving**, **LLM-driven classification**, and a set of **source-specific ingestion scripts**. The core idea is strong: domain-partitioned memory across `work`, `personal`, `life`, and `learning`, with semantic retrieval and an ontology intended to encode routing and privacy rules.

Architecturally, it is promising but clearly in a **transition state**. There is a newer domain-aware v2 path alongside older single-table assumptions and a second, simpler MCP implementation. The biggest issue is not the vision. It is **version drift** and **incomplete policy enforcement**.

## Current architecture

### Primary data model

The newer architecture uses **four separate Supabase schemas**:

- `ob_work`
- `ob_personal`
- `ob_life`
- `ob_learning`

Each schema appears to have its own `thoughts` table plus indexes for:

- vector search
- JSONB metadata
- timestamps

There are shared database functions for:

- per-domain vector search
- cross-domain search
- domain stats
- ontology proposal storage

This is a sensible design. It creates cleaner privacy boundaries and a clearer operational model than a single mixed table.

### Runtime surfaces

There are effectively **two server implementations**:

- `engram/server.ts`
  - newer
  - domain-aware
  - ontology-aware
  - MCP over stdio
  - appears to be the intended main path

- `engram/functions/engram-mcp/index.ts`
  - older
  - simpler
  - Supabase Edge / Deno HTTP style
  - still assumes a single-table `public.thoughts` model

This split is the main architectural warning sign.

### Ingestion layer

There are multiple source-specific scripts, including:

- email
- Slack
- calendar
- Notion meetings
- sessions
- PAI context backups
- pull/sync jobs
- maintenance jobs such as re-embed, rechunk, and migrate

This is practical for a single operator, but the scripts appear fairly independent rather than built on a shared internal library.

### Ontology

The ontology is one of the stronger ideas in the codebase.

It defines:

- domains
- entity types
- horizons
- inference rules
- synapse rules
- evolution proposals

The main server uses it during capture and classification, and can generate ontology proposals when gaps are found.

## Strengths

### Clear domain separation

Using separate schemas for different domains is a strong architectural choice. It is easier to reason about, easier to secure, and easier to evolve.

### Good storage primitives

Postgres + pgvector + JSONB + proper indexes is a pragmatic and credible stack for this workload.

### Useful metadata model

This is not just embedding storage. The model captures:

- people
- topics
- action items
- dates
- project IDs
- horizons
- sensitivity

That makes retrieval more operationally useful.

### Project-oriented retrieval

Capabilities like project-centric aggregation show that Engram is aimed at real decision support, not just passive memory storage.

### Ontology evolution loop

Recording classifier gaps as ontology proposals is a good architectural pattern. It provides a path from messy real-world input to controlled schema growth.

## Weaknesses and risks

### 1. Version drift

This is the biggest issue.

The codebase currently contains:

- a v2 domain-partitioned model
- older v1-style code still present
- two MCP server implementations
- legacy schema assumptions in some scripts
- maintenance scripts that may still target `public.thoughts`

That means the intended architecture and the operational architecture are not yet fully aligned. This kind of drift creates silent failure risk.

### 2. Privacy model appears stronger in design than in enforcement

The privacy story is compelling, but it does not yet appear fully enforced in code.

Observed concerns:

- cross-domain access expands domain visibility
- sensitivity constraints do not appear fully enforced at query time
- `never_cross` handling appears inconsistent
- synapse rules seem only partially applied

So the current state looks more like a **declared privacy model** than a **provably enforced privacy model**.

### 3. High duplication and low modularity

Repeated logic appears across scripts for:

- environment/config loading
- embedding calls
- OpenAI/Voyage handling
- Supabase access
- classification flow
- retry and operational patterns

That duplication will make drift worse over time.

### 4. Packaging is not clean enough

A concrete example:

- `server.ts` imports `zod`
- `package.json` does not declare `zod`

So a clean install may fail. I also did not find a crisp reproducible contract for:

- scripts
- lockfile discipline
- tests
- validation gates

### 5. Single-operator coupling

A lot of the ingestion model assumes one machine and one operator:

- local files
- macOS automation
- Apple Mail and EventKit
- launchd
- user-specific paths

That is acceptable for a personal system, but fragile if the aim is portability, delegation, or higher reliability.

## Operational concerns

### Secrets exposure risk

The system uses broad service-role Supabase access. If that key leaks, domain boundaries are effectively compromised.

### Observability is thin

There are logs and scripts, but not much in the way of:

- structured metrics
- ingestion dashboards
- failure summaries
- health signals
- audit views

For a system intended to become trusted memory, that is a meaningful gap.

### Migration ambiguity

As long as legacy and current models coexist, there is risk of:

- writing to the wrong place
- maintaining only part of the system
- fixing one codepath while another remains stale

### Weak automated gates

I did not find clear safety rails such as:

- ontology validation
- schema compatibility checks
- dependency/import verification
- dry-run ingestion smoke tests

## Architectural conclusion

**Engram has a credible architectural centre, but it is not yet fully consolidated.**

The strong parts are real:

- domain partitioning
- semantic retrieval
- structured metadata
- ontology-assisted routing
- source-specific sync

But the system needs a cleanup and consolidation phase before it becomes a trustworthy platform.

Right now it feels like:

- **good architecture emerging**
- inside **an unfinished migration**

## Recommended next steps

### 1. Declare the canonical architecture

Pick one architecture as the source of truth:

- `server.ts` + multi-schema domain model

Then explicitly retire or quarantine:

- the old Edge function path
- legacy single-table assumptions
- v1 maintenance scripts

### 2. Enforce privacy in code, not prose

Cross-domain access should be governed by real enforcement:

- sensitivity allowlists
- `never_cross` hard blocks
- synapse filtering at query time
- ideally shared-library or DB-level enforcement

### 3. Extract shared internal libraries

Create common modules for:

- config
- embeddings
- classification
- Supabase access
- retries
- metadata helpers
- domain routing

This will reduce script drift quickly.

### 4. Refactor maintenance and admin tooling

Normalise:

- migrate
- re-embed
- rechunk
- backfill

These should all understand the multi-schema architecture, or be explicitly marked legacy.

### 5. Add a minimal validation suite

At minimum:

- ontology parse check
- dependency/import check
- schema compatibility check
- dry-run sync smoke tests

### 6. Fix packaging

Add missing dependencies such as `zod`, and establish a clean install and run contract.

## Bottom line

If the question is, **is this a real architectural foundation?**

Yes.

If the question is, **is it clean, canonical, and enforceable yet?**

Not quite.

It has a strong spine. It now needs consolidation.
