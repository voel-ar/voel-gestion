-- VOËL Gestión · estructura de la base (proyecto Supabase propio de VOËL)
create table if not exists public.miembros (
  user_id uuid primary key references auth.users(id) on delete cascade,
  nombre text not null,
  rol text not null check (rol in ('dueño','equipo')),
  ids_anteriores text[] not null default '{}',
  creado timestamptz not null default now()
);

create table if not exists public.docs (
  col text not null,
  id text not null,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  primary key (col, id)
);

create or replace function public.es_miembro() returns boolean
  language sql stable security definer set search_path = public
  as $$ select exists (select 1 from public.miembros where user_id = auth.uid()) $$;

create or replace function public.es_dueno() returns boolean
  language sql stable security definer set search_path = public
  as $$ select exists (select 1 from public.miembros where user_id = auth.uid() and rol = 'dueño') $$;

-- Colecciones que solo ve y modifica el dueño (ganancias, sueldos, costos, deudas, pagos, caja)
create or replace function public.col_privada(c text) returns boolean
  language sql immutable
  as $$ select c in ('config','compras','pagosProv','caja','personal','liquidaciones','pagosPers','articulos','ordenesValor','pagosTaller') $$;

create or replace function public.docs_marcar() returns trigger
  language plpgsql security definer set search_path = public
  as $$ begin
    new.updated_at := now();
    if auth.uid() is not null then new.updated_by := auth.uid(); end if;
    return new;
  end $$;
drop trigger if exists docs_marcar on public.docs;
create trigger docs_marcar before insert or update on public.docs for each row execute function public.docs_marcar();

alter table public.docs enable row level security;
alter table public.miembros enable row level security;

drop policy if exists docs_leer on public.docs;
drop policy if exists docs_crear on public.docs;
drop policy if exists docs_editar on public.docs;
drop policy if exists docs_borrar on public.docs;
create policy docs_leer   on public.docs for select to authenticated using (public.es_miembro() and (not public.col_privada(col) or public.es_dueno()));
create policy docs_crear  on public.docs for insert to authenticated with check (public.es_miembro() and (not public.col_privada(col) or public.es_dueno()));
create policy docs_editar on public.docs for update to authenticated using (public.es_miembro() and (not public.col_privada(col) or public.es_dueno())) with check (public.es_miembro() and (not public.col_privada(col) or public.es_dueno()));
create policy docs_borrar on public.docs for delete to authenticated using (public.es_dueno());

drop policy if exists miembros_leer on public.miembros;
create policy miembros_leer on public.miembros for select to authenticated using (public.es_miembro());

revoke all on public.docs from anon;
revoke all on public.miembros from anon;
grant select, insert, update, delete on public.docs to authenticated;
grant select on public.miembros to authenticated;

alter table public.docs replica identity full;
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'docs') then
    alter publication supabase_realtime add table public.docs;
  end if;
end $$;
