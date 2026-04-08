-- Engram Schema
-- Run this in Supabase SQL Editor (Dashboard > SQL Editor > New Query)

-- 1. Enable pgvector extension
create extension if not exists vector with schema extensions;

-- 2. Create thoughts table
create table if not exists public.thoughts (
  id uuid primary key default gen_random_uuid(),
  content text not null,
  embedding extensions.vector(1024),
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- 3. Auto-update updated_at
create or replace function update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger thoughts_updated_at
  before update on public.thoughts
  for each row execute function update_updated_at();

-- 4. Indexes
-- HNSW index for fast cosine similarity search
create index if not exists thoughts_embedding_idx
  on public.thoughts
  using hnsw (embedding extensions.vector_cosine_ops)
  with (m = 16, ef_construction = 64);

-- GIN index for JSONB metadata filtering
create index if not exists thoughts_metadata_idx
  on public.thoughts
  using gin (metadata);

-- Date index for recent queries
create index if not exists thoughts_created_at_idx
  on public.thoughts (created_at desc);

-- 5. Semantic search function
create or replace function match_thoughts(
  query_embedding extensions.vector(1024),
  match_threshold float default 0.5,
  match_count int default 10,
  filter_metadata jsonb default '{}'::jsonb
)
returns table (
  id uuid,
  content text,
  metadata jsonb,
  similarity float,
  created_at timestamptz
)
language plpgsql
as $$
begin
  return query
  select
    t.id,
    t.content,
    t.metadata,
    1 - (t.embedding <=> query_embedding) as similarity,
    t.created_at
  from public.thoughts t
  where 1 - (t.embedding <=> query_embedding) > match_threshold
    and (filter_metadata = '{}'::jsonb or t.metadata @> filter_metadata)
  order by t.embedding <=> query_embedding
  limit match_count;
end;
$$;

-- 6. Stats function
create or replace function thought_stats()
returns jsonb
language plpgsql
as $$
declare
  result jsonb;
begin
  select jsonb_build_object(
    'total', (select count(*) from public.thoughts),
    'types', (
      select jsonb_object_agg(t, c)
      from (
        select metadata->>'type' as t, count(*) as c
        from public.thoughts
        where metadata->>'type' is not null
        group by metadata->>'type'
        order by c desc
      ) sub
    ),
    'top_topics', (
      select jsonb_agg(topic)
      from (
        select jsonb_array_elements_text(metadata->'topics') as topic, count(*) as c
        from public.thoughts
        where metadata->'topics' is not null
        group by topic
        order by c desc
        limit 10
      ) sub
    ),
    'top_people', (
      select jsonb_agg(person)
      from (
        select jsonb_array_elements_text(metadata->'people') as person, count(*) as c
        from public.thoughts
        where metadata->'people' is not null
        group by person
        order by c desc
        limit 10
      ) sub
    ),
    'date_range', jsonb_build_object(
      'earliest', (select min(created_at) from public.thoughts),
      'latest', (select max(created_at) from public.thoughts)
    )
  ) into result;
  return result;
end;
$$;

-- 7. Enable RLS
alter table public.thoughts enable row level security;

-- Allow service role full access (edge functions use service role)
create policy "Service role full access"
  on public.thoughts
  for all
  using (true)
  with check (true);

-- Done! Your Engram schema is ready.
