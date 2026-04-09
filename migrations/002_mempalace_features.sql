-- ============================================================
-- OpenBrain v2.1 Migration: MemPalace-Inspired Features
-- Run in Supabase SQL Editor (Dashboard > SQL Editor > New Query)
--
-- Features:
--   1. Temporal Knowledge Graph (ob_relationships table)
--   2. Verbatim Drawer Layer (raw_source column)
--   3. Tunnel Discovery (uses existing metadata, no schema changes)
--   4. Wake-Up Mode (importance column)
-- ============================================================

-- ============================================================
-- 1. TEMPORAL KNOWLEDGE GRAPH
-- ============================================================

create table if not exists public.ob_relationships (
  id uuid primary key default gen_random_uuid(),
  subject text not null,
  subject_domain text not null default 'work',
  object text not null,
  object_domain text not null default 'work',
  predicate text not null,
  properties jsonb default '{}'::jsonb,
  valid_from timestamptz not null default now(),
  valid_to timestamptz,  -- null = currently valid
  source_thought_id uuid,
  created_at timestamptz default now()
);

-- Indexes for entity queries
create index if not exists rel_subject_predicate_idx
  on public.ob_relationships (subject, predicate);

create index if not exists rel_object_predicate_idx
  on public.ob_relationships (object, predicate);

-- Index for temporal queries (find what was true at a point in time)
create index if not exists rel_temporal_idx
  on public.ob_relationships (valid_from, valid_to);

-- GIN index for properties JSONB
create index if not exists rel_properties_idx
  on public.ob_relationships using gin (properties);

-- RLS
alter table public.ob_relationships enable row level security;

create policy "Service role full access"
  on public.ob_relationships
  for all
  using (true)
  with check (true);

-- ============================================================
-- 2. VERBATIM DRAWER LAYER (raw_source column)
-- ============================================================

alter table ob_work.thoughts add column if not exists raw_source text;
alter table ob_personal.thoughts add column if not exists raw_source text;
alter table ob_life.thoughts add column if not exists raw_source text;
alter table ob_learning.thoughts add column if not exists raw_source text;

-- ============================================================
-- 3. WAKE-UP MODE (importance column + index)
-- ============================================================

alter table ob_work.thoughts add column if not exists importance float;
alter table ob_personal.thoughts add column if not exists importance float;
alter table ob_life.thoughts add column if not exists importance float;
alter table ob_learning.thoughts add column if not exists importance float;

-- Indexes for fast importance-based retrieval
create index if not exists work_importance_idx
  on ob_work.thoughts (importance desc nulls last);

create index if not exists personal_importance_idx
  on ob_personal.thoughts (importance desc nulls last);

create index if not exists life_importance_idx
  on ob_life.thoughts (importance desc nulls last);

create index if not exists learning_importance_idx
  on ob_learning.thoughts (importance desc nulls last);

-- ============================================================
-- 4. HELPER: Query relationships valid at a point in time
-- ============================================================

create or replace function public.query_relationships_at(
  target_entity text,
  as_of timestamptz default now(),
  rel_predicate text default null,
  max_results int default 50
)
returns table (
  id uuid,
  subject text,
  subject_domain text,
  object text,
  object_domain text,
  predicate text,
  properties jsonb,
  valid_from timestamptz,
  valid_to timestamptz,
  source_thought_id uuid
)
language plpgsql as $$
begin
  return query
  select r.id, r.subject, r.subject_domain, r.object, r.object_domain,
         r.predicate, r.properties, r.valid_from, r.valid_to, r.source_thought_id
  from public.ob_relationships r
  where (r.subject = target_entity or r.object = target_entity)
    and r.valid_from <= as_of
    and (r.valid_to is null or r.valid_to > as_of)
    and (rel_predicate is null or r.predicate = rel_predicate)
  order by r.valid_from desc
  limit max_results;
end;
$$;

-- ============================================================
-- DONE. Run backfill-importance.ts to set importance on existing thoughts.
-- ============================================================
