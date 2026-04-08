-- ============================================================
-- Engram v2 Migration: Domain Schemas
-- Run in Supabase SQL Editor (Dashboard > SQL Editor > New Query)
--
-- Creates 4 domain schemas with isolated thoughts tables,
-- semantic search, and cross-domain query support.
-- Migrates existing data from public.thoughts.
-- ============================================================

-- 0. Ensure pgvector is available
create extension if not exists vector with schema extensions;

-- ============================================================
-- 1. CREATE SCHEMAS
-- ============================================================

create schema if not exists ob_work;
create schema if not exists ob_personal;
create schema if not exists ob_life;
create schema if not exists ob_learning;

-- ============================================================
-- 2. CREATE THOUGHTS TABLES (one per schema)
-- ============================================================

-- Helper: create a thoughts table in a given schema
-- We use DO blocks since CREATE TABLE doesn't support schema variables

-- ob_work.thoughts
create table if not exists ob_work.thoughts (
  id uuid primary key default gen_random_uuid(),
  content text not null,
  embedding extensions.vector(1024),
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ob_personal.thoughts
create table if not exists ob_personal.thoughts (
  id uuid primary key default gen_random_uuid(),
  content text not null,
  embedding extensions.vector(1024),
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ob_life.thoughts
create table if not exists ob_life.thoughts (
  id uuid primary key default gen_random_uuid(),
  content text not null,
  embedding extensions.vector(1024),
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ob_learning.thoughts
create table if not exists ob_learning.thoughts (
  id uuid primary key default gen_random_uuid(),
  content text not null,
  embedding extensions.vector(1024),
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ============================================================
-- 3. AUTO-UPDATE TRIGGERS (updated_at)
-- ============================================================

create or replace function update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger thoughts_updated_at before update on ob_work.thoughts
  for each row execute function update_updated_at();
create trigger thoughts_updated_at before update on ob_personal.thoughts
  for each row execute function update_updated_at();
create trigger thoughts_updated_at before update on ob_life.thoughts
  for each row execute function update_updated_at();
create trigger thoughts_updated_at before update on ob_learning.thoughts
  for each row execute function update_updated_at();

-- ============================================================
-- 4. INDEXES
-- ============================================================

-- HNSW vector indexes for semantic search
create index if not exists work_thoughts_embedding_idx
  on ob_work.thoughts using hnsw (embedding extensions.vector_cosine_ops)
  with (m = 16, ef_construction = 64);

create index if not exists personal_thoughts_embedding_idx
  on ob_personal.thoughts using hnsw (embedding extensions.vector_cosine_ops)
  with (m = 16, ef_construction = 64);

create index if not exists life_thoughts_embedding_idx
  on ob_life.thoughts using hnsw (embedding extensions.vector_cosine_ops)
  with (m = 16, ef_construction = 64);

create index if not exists learning_thoughts_embedding_idx
  on ob_learning.thoughts using hnsw (embedding extensions.vector_cosine_ops)
  with (m = 16, ef_construction = 64);

-- GIN indexes for JSONB metadata filtering
create index if not exists work_thoughts_metadata_idx on ob_work.thoughts using gin (metadata);
create index if not exists personal_thoughts_metadata_idx on ob_personal.thoughts using gin (metadata);
create index if not exists life_thoughts_metadata_idx on ob_life.thoughts using gin (metadata);
create index if not exists learning_thoughts_metadata_idx on ob_learning.thoughts using gin (metadata);

-- Date indexes
create index if not exists work_thoughts_created_at_idx on ob_work.thoughts (created_at desc);
create index if not exists personal_thoughts_created_at_idx on ob_personal.thoughts (created_at desc);
create index if not exists life_thoughts_created_at_idx on ob_life.thoughts (created_at desc);
create index if not exists learning_thoughts_created_at_idx on ob_learning.thoughts (created_at desc);

-- ============================================================
-- 5. DOMAIN-SCOPED SEMANTIC SEARCH FUNCTIONS
-- ============================================================

create or replace function ob_work.match_thoughts(
  query_embedding extensions.vector(1024),
  match_threshold float default 0.5,
  match_count int default 10,
  filter_metadata jsonb default '{}'::jsonb
)
returns table (id uuid, content text, metadata jsonb, similarity float, created_at timestamptz)
language plpgsql as $$
begin
  return query
  select t.id, t.content, t.metadata,
    1 - (t.embedding <=> query_embedding) as similarity,
    t.created_at
  from ob_work.thoughts t
  where 1 - (t.embedding <=> query_embedding) > match_threshold
    and (filter_metadata = '{}'::jsonb or t.metadata @> filter_metadata)
  order by t.embedding <=> query_embedding
  limit match_count;
end;
$$;

create or replace function ob_personal.match_thoughts(
  query_embedding extensions.vector(1024),
  match_threshold float default 0.5,
  match_count int default 10,
  filter_metadata jsonb default '{}'::jsonb
)
returns table (id uuid, content text, metadata jsonb, similarity float, created_at timestamptz)
language plpgsql as $$
begin
  return query
  select t.id, t.content, t.metadata,
    1 - (t.embedding <=> query_embedding) as similarity,
    t.created_at
  from ob_personal.thoughts t
  where 1 - (t.embedding <=> query_embedding) > match_threshold
    and (filter_metadata = '{}'::jsonb or t.metadata @> filter_metadata)
  order by t.embedding <=> query_embedding
  limit match_count;
end;
$$;

create or replace function ob_life.match_thoughts(
  query_embedding extensions.vector(1024),
  match_threshold float default 0.5,
  match_count int default 10,
  filter_metadata jsonb default '{}'::jsonb
)
returns table (id uuid, content text, metadata jsonb, similarity float, created_at timestamptz)
language plpgsql as $$
begin
  return query
  select t.id, t.content, t.metadata,
    1 - (t.embedding <=> query_embedding) as similarity,
    t.created_at
  from ob_life.thoughts t
  where 1 - (t.embedding <=> query_embedding) > match_threshold
    and (filter_metadata = '{}'::jsonb or t.metadata @> filter_metadata)
  order by t.embedding <=> query_embedding
  limit match_count;
end;
$$;

create or replace function ob_learning.match_thoughts(
  query_embedding extensions.vector(1024),
  match_threshold float default 0.5,
  match_count int default 10,
  filter_metadata jsonb default '{}'::jsonb
)
returns table (id uuid, content text, metadata jsonb, similarity float, created_at timestamptz)
language plpgsql as $$
begin
  return query
  select t.id, t.content, t.metadata,
    1 - (t.embedding <=> query_embedding) as similarity,
    t.created_at
  from ob_learning.thoughts t
  where 1 - (t.embedding <=> query_embedding) > match_threshold
    and (filter_metadata = '{}'::jsonb or t.metadata @> filter_metadata)
  order by t.embedding <=> query_embedding
  limit match_count;
end;
$$;

-- ============================================================
-- 6. CROSS-DOMAIN SEARCH (respects sensitivity rules)
-- Only returns results from domains with allowed sensitivity.
-- Domains parameter: array of schema names to search.
-- ============================================================

create or replace function public.match_thoughts_cross_domain(
  query_embedding extensions.vector(1024),
  domains text[] default array['ob_work', 'ob_learning'],
  match_threshold float default 0.5,
  match_count int default 10,
  filter_metadata jsonb default '{}'::jsonb
)
returns table (
  id uuid,
  content text,
  metadata jsonb,
  similarity float,
  created_at timestamptz,
  domain text
)
language plpgsql as $$
begin
  return query
  (
    select t.id, t.content, t.metadata,
      1 - (t.embedding <=> query_embedding) as similarity,
      t.created_at, 'work'::text as domain
    from ob_work.thoughts t
    where 'ob_work' = any(domains)
      and 1 - (t.embedding <=> query_embedding) > match_threshold
      and (filter_metadata = '{}'::jsonb or t.metadata @> filter_metadata)
  )
  union all
  (
    select t.id, t.content, t.metadata,
      1 - (t.embedding <=> query_embedding) as similarity,
      t.created_at, 'personal'::text as domain
    from ob_personal.thoughts t
    where 'ob_personal' = any(domains)
      and 1 - (t.embedding <=> query_embedding) > match_threshold
      and (filter_metadata = '{}'::jsonb or t.metadata @> filter_metadata)
  )
  union all
  (
    select t.id, t.content, t.metadata,
      1 - (t.embedding <=> query_embedding) as similarity,
      t.created_at, 'life'::text as domain
    from ob_life.thoughts t
    where 'ob_life' = any(domains)
      and 1 - (t.embedding <=> query_embedding) > match_threshold
      and (filter_metadata = '{}'::jsonb or t.metadata @> filter_metadata)
  )
  union all
  (
    select t.id, t.content, t.metadata,
      1 - (t.embedding <=> query_embedding) as similarity,
      t.created_at, 'learning'::text as domain
    from ob_learning.thoughts t
    where 'ob_learning' = any(domains)
      and 1 - (t.embedding <=> query_embedding) > match_threshold
      and (filter_metadata = '{}'::jsonb or t.metadata @> filter_metadata)
  )
  order by similarity desc
  limit match_count;
end;
$$;

-- ============================================================
-- 7. DOMAIN-SCOPED STATS FUNCTIONS
-- ============================================================

create or replace function public.thought_stats_by_domain(target_domain text default 'work')
returns jsonb
language plpgsql as $$
declare
  result jsonb;
  schema_name text;
begin
  schema_name := 'ob_' || target_domain;

  execute format('
    select jsonb_build_object(
      ''domain'', %L,
      ''total'', (select count(*) from %I.thoughts),
      ''types'', (
        select coalesce(jsonb_object_agg(t, c), ''{}''::jsonb)
        from (
          select metadata->>''type'' as t, count(*) as c
          from %I.thoughts
          where metadata->>''type'' is not null
          group by metadata->>''type''
          order by c desc
        ) sub
      ),
      ''top_topics'', (
        select coalesce(jsonb_agg(topic), ''[]''::jsonb)
        from (
          select jsonb_array_elements_text(metadata->''topics'') as topic, count(*) as c
          from %I.thoughts
          where metadata->''topics'' is not null
          group by topic
          order by c desc
          limit 10
        ) sub
      ),
      ''date_range'', jsonb_build_object(
        ''earliest'', (select min(created_at) from %I.thoughts),
        ''latest'', (select max(created_at) from %I.thoughts)
      )
    )', target_domain, schema_name, schema_name, schema_name, schema_name, schema_name)
  into result;

  return result;
end;
$$;

-- ============================================================
-- 8. RLS POLICIES
-- ============================================================

alter table ob_work.thoughts enable row level security;
alter table ob_personal.thoughts enable row level security;
alter table ob_life.thoughts enable row level security;
alter table ob_learning.thoughts enable row level security;

create policy "Service role full access" on ob_work.thoughts for all using (true) with check (true);
create policy "Service role full access" on ob_personal.thoughts for all using (true) with check (true);
create policy "Service role full access" on ob_life.thoughts for all using (true) with check (true);
create policy "Service role full access" on ob_learning.thoughts for all using (true) with check (true);

-- ============================================================
-- 9. ONTOLOGY EVOLUTION TABLE
-- ============================================================

create table if not exists public.ob_ontology_proposals (
  id uuid primary key default gen_random_uuid(),
  version_from text not null,
  version_to text not null,
  entity_type text,
  change_type text not null, -- 'add_entity', 'add_relationship', 'change_sensitivity', 'add_inference_rule'
  proposal jsonb not null,
  rationale text,
  status text default 'pending', -- 'pending', 'approved', 'rejected'
  created_at timestamptz default now(),
  resolved_at timestamptz
);

-- ============================================================
-- 10. MIGRATE EXISTING DATA
-- Classification rules:
--   personal: people contains family member names or topics contain
--             "co-parenting", "custody", "psychological", "family dynamics"
--   learning: type = "learning", "youtube-video", "youtube-video-summary",
--             "research-summary", "competitive-research", "strategic-intelligence"
--   life:     type = "daily_briefing" or topics contain "health", "goals", "telos"
--   work:     everything else (meetings, observations about work, etc.)
-- ============================================================

-- Personal domain
insert into ob_personal.thoughts (id, content, embedding, metadata, created_at, updated_at)
select id, content, embedding, metadata || jsonb_build_object('_migrated_from', 'public', '_original_domain', 'auto_personal'), created_at, updated_at
from public.thoughts
where (
  -- Replace with your family member names for migration
  metadata->'people' ?| array['Jane Doe', 'John Doe Jr', 'Alice Doe']
  or metadata->'topics' ?| array['attachment theory', 'co-parenting', 'custody', 'psychological profile', 'family dynamics']
  or content ilike '%Jane%Doe%'
);

-- Learning domain
insert into ob_learning.thoughts (id, content, embedding, metadata, created_at, updated_at)
select id, content, embedding, metadata || jsonb_build_object('_migrated_from', 'public', '_original_domain', 'auto_learning'), created_at, updated_at
from public.thoughts
where id not in (select id from ob_personal.thoughts)
  and (
    metadata->>'type' in ('learning', 'youtube-video', 'youtube-video-summary', 'research-summary', 'competitive-research', 'strategic-intelligence')
    or metadata->>'source' = 'extract-wisdom'
  );

-- Life domain (daily briefings, health, goals)
insert into ob_life.thoughts (id, content, embedding, metadata, created_at, updated_at)
select id, content, embedding, metadata || jsonb_build_object('_migrated_from', 'public', '_original_domain', 'auto_life'), created_at, updated_at
from public.thoughts
where id not in (select id from ob_personal.thoughts)
  and id not in (select id from ob_learning.thoughts)
  and (
    metadata->>'type' = 'daily_briefing'
    or metadata->'topics' ?| array['health', 'goals', 'telos', 'life', 'wellbeing']
  );

-- Work domain (everything remaining)
insert into ob_work.thoughts (id, content, embedding, metadata, created_at, updated_at)
select id, content, embedding, metadata || jsonb_build_object('_migrated_from', 'public', '_original_domain', 'auto_work'), created_at, updated_at
from public.thoughts
where id not in (select id from ob_personal.thoughts)
  and id not in (select id from ob_learning.thoughts)
  and id not in (select id from ob_life.thoughts);

-- ============================================================
-- 11. VERIFY MIGRATION
-- ============================================================

do $$
declare
  src_count int;
  dst_count int;
  work_count int;
  personal_count int;
  life_count int;
  learning_count int;
begin
  select count(*) into src_count from public.thoughts;
  select count(*) into work_count from ob_work.thoughts;
  select count(*) into personal_count from ob_personal.thoughts;
  select count(*) into life_count from ob_life.thoughts;
  select count(*) into learning_count from ob_learning.thoughts;
  dst_count := work_count + personal_count + life_count + learning_count;

  raise notice '=== MIGRATION RESULTS ===';
  raise notice 'Source (public.thoughts): % rows', src_count;
  raise notice 'Work:     % rows', work_count;
  raise notice 'Personal: % rows', personal_count;
  raise notice 'Life:     % rows', life_count;
  raise notice 'Learning: % rows', learning_count;
  raise notice 'Total migrated: % rows', dst_count;

  if src_count != dst_count then
    raise warning 'MISMATCH: source % != destination %', src_count, dst_count;
  else
    raise notice 'VERIFIED: all % rows migrated successfully', src_count;
  end if;
end;
$$;

-- ============================================================
-- 12. EXPOSE SCHEMAS TO POSTGREST
-- Add these schemas to the "Exposed schemas" setting in
-- Supabase Dashboard > Settings > API > Exposed schemas
-- Add: ob_work, ob_personal, ob_life, ob_learning
-- ============================================================

-- Note: This must be done in the Supabase Dashboard UI:
-- Settings > API > "Extra search path" or "Exposed schemas"
-- Add the 4 schemas so PostgREST can access them.
-- Until this is done, the MCP server uses direct SQL via supabase-js .rpc() calls.

-- ============================================================
-- DONE. public.thoughts is retained as backup.
-- Once verified, you can drop it with:
--   DROP TABLE public.thoughts;
-- ============================================================
