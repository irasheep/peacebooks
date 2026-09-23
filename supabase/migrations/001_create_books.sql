-- Книги Мира: каталог книг (MVP)
-- One row = one physical copy on the shelf.
-- ISBN is intentionally NOT unique: two physical copies may share the same ISBN.

create extension if not exists pgcrypto;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'book_status') then
    create type book_status as enum ('available', 'unavailable');
  end if;
end $$;

create table if not exists public.books (
  id uuid primary key default gen_random_uuid(),

  title text not null check (length(trim(title)) > 0),
  author text not null check (length(trim(author)) > 0),
  annotation text not null check (length(trim(annotation)) > 0),
  isbn text not null check (length(trim(isbn)) > 0),

  -- Permanent path/URL in our own storage. Do not rely on temporary Notion file URLs.
  cover_url text not null check (length(trim(cover_url)) > 0),

  status book_status not null default 'available',

  -- Used for "newest first" sorting inside each availability group.
  added_at timestamptz not null default now(),

  -- Soft delete: removing a row from the source does not destroy loan/history data later.
  is_active boolean not null default true,

  -- Source tracking for one-way Notion -> Postgres sync.
  notion_page_id text unique,
  notion_last_edited_at timestamptz,
  synced_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists books_set_updated_at on public.books;

create trigger books_set_updated_at
before update on public.books
for each row
execute function public.set_updated_at();

-- Catalog order:
-- 1) available books first
-- 2) newest additions first inside each group
create index if not exists books_catalog_sort_idx
on public.books (status, added_at desc)
where is_active = true;

create index if not exists books_notion_page_id_idx
on public.books (notion_page_id)
where notion_page_id is not null;

alter table public.books enable row level security;

-- The catalog itself may be read from the Mini App.
-- Mutations will later go through trusted backend/admin flows.
drop policy if exists "Public can read active catalog" on public.books;

create policy "Public can read active catalog"
on public.books
for select
using (is_active = true);
