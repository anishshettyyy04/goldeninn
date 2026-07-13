-- ============================================================
-- GOLDEN INN — Database fix
-- Run this once in Supabase → SQL Editor
-- Fixes 3 schema mismatches that were breaking saves/loads:
--   1. site_content.id was INTEGER, code sends the string 'main'
--   2. media table was named "media", code expects "media_library"
--   3. messages column was "sentAt" (quoted camelCase),
--      code reads/writes sent_at
-- ============================================================

-- 1. Fix site_content id type so id:'main' can be saved/read
alter table site_content alter column id drop default;
alter table site_content alter column id type text using id::text;
alter table site_content alter column id set default 'main';

-- 2. Recreate media table under the name the app actually uses
drop table if exists media;
create table if not exists media_library (
  id uuid primary key default gen_random_uuid(),
  name text,
  url text,
  size numeric,
  type text,
  added_at timestamptz default now()
);
alter table media_library disable row level security;

-- 3. Fix messages timestamp column name/type
alter table messages rename column "sentAt" to sent_at;
alter table messages alter column sent_at type timestamptz using
  case when sent_at ~ '^\d{4}-\d{2}-\d{2}' then sent_at::timestamptz else now() end;
alter table messages alter column sent_at set default now();
