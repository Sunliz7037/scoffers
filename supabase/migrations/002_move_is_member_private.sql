-- Scoffers: move the membership check out of the public API.
-- Paste into Supabase → SQL Editor → New query, then Run.

create schema if not exists private;

create or replace function private.is_member()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.members where user_id = auth.uid());
$$;

grant usage on schema private to authenticated;
grant execute on function private.is_member() to authenticated;
revoke execute on function private.is_member() from public, anon;

do $$
declare t text;
begin
  foreach t in array array['accounts','jars','transactions','allocations','transfer_rules','planned_items','planned_matches','jar_coverage']
  loop
    execute format('drop policy members_all on public.%I', t);
    execute format('create policy members_all on public.%I for all to authenticated using (private.is_member()) with check (private.is_member())', t);
  end loop;
end $$;

drop policy members_read on public.members;
create policy members_read on public.members for select to authenticated using (private.is_member());

drop function public.is_member();

comment on table public.plaid_items is 'Server-only: no client policies by design; accessed with the service role.';
