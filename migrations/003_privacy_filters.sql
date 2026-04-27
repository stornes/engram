-- ============================================================
-- Engram v2.2 Migration: Privacy Filters
-- Run in Supabase SQL Editor (Dashboard > SQL Editor > New Query)
--
-- Adds defense-in-depth privacy enforcement to the cross-domain
-- search RPC. The application layer (server.ts) is the primary
-- enforcer of synapse rules and sensitivity ceilings; this RPC
-- now also applies the never_cross quarantine list at the SQL
-- layer, so a buggy or compromised caller cannot exfiltrate
-- never_cross types via cross_domain search.
--
-- Drops and recreates public.match_thoughts_cross_domain with a
-- new optional parameter `never_cross_types text[]`. Rows whose
-- metadata->>'type' appears in that list are filtered out.
--
-- After applying this migration, server.ts must pass the list on
-- every call. Older clients that omit the parameter still work
-- (default empty list = no filtering — same as previous behaviour).
-- ============================================================

drop function if exists public.match_thoughts_cross_domain(
  extensions.vector,
  text[],
  float,
  int,
  jsonb
);

create or replace function public.match_thoughts_cross_domain(
  query_embedding extensions.vector(1024),
  domains text[] default array['ob_work', 'ob_learning'],
  match_threshold float default 0.5,
  match_count int default 10,
  filter_metadata jsonb default '{}'::jsonb,
  never_cross_types text[] default array[]::text[]
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
      and (
        cardinality(never_cross_types) = 0
        or coalesce(t.metadata->>'type', '') <> all(never_cross_types)
      )
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
      and (
        cardinality(never_cross_types) = 0
        or coalesce(t.metadata->>'type', '') <> all(never_cross_types)
      )
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
      and (
        cardinality(never_cross_types) = 0
        or coalesce(t.metadata->>'type', '') <> all(never_cross_types)
      )
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
      and (
        cardinality(never_cross_types) = 0
        or coalesce(t.metadata->>'type', '') <> all(never_cross_types)
      )
  )
  order by similarity desc
  limit match_count;
end;
$$;
