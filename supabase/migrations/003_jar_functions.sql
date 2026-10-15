-- Scoffers jar helpers (applied 2026-10-15). Each runs as the signed-in user,
-- so row-level security still applies, and each change happens in one step.

create or replace function public.jar_balance(p_jar uuid)
returns numeric language sql stable security invoker set search_path = public as $$
  select coalesce(sum(amount),0) from public.allocations where jar_id = p_jar;
$$;

create or replace function public.jar_move(p_from uuid, p_to uuid, p_amount numeric, p_note text default null)
returns void language plpgsql security invoker set search_path = public as $$
begin
  if not private.is_member() then raise exception 'Not allowed'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Amount must be more than $0'; end if;
  if p_from = p_to then raise exception 'Pick two different jars'; end if;
  if public.jar_balance(p_from) < p_amount then raise exception 'That jar only has $%', public.jar_balance(p_from); end if;
  insert into public.allocations (jar_id, amount, kind, note) values
    (p_from, -p_amount, 'move', p_note),
    (p_to,    p_amount, 'move', p_note);
end $$;

create or replace function public.jar_withdraw(p_jar uuid, p_amount numeric, p_note text default null)
returns void language plpgsql security invoker set search_path = public as $$
begin
  if not private.is_member() then raise exception 'Not allowed'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Amount must be more than $0'; end if;
  if public.jar_balance(p_jar) < p_amount then raise exception 'That jar only has $%', public.jar_balance(p_jar); end if;
  insert into public.allocations (jar_id, amount, kind, note) values (p_jar, -p_amount, 'withdrawal', p_note);
end $$;

-- Splits a deposit across jars when it equals the allotment total; otherwise it goes to the catch-all.
create or replace function public.jar_record_deposit(p_amount numeric, p_note text default null)
returns text language plpgsql security invoker set search_path = public as $$
declare v_total numeric; v_catch uuid;
begin
  if not private.is_member() then raise exception 'Not allowed'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Amount must be more than $0'; end if;
  select coalesce(sum(per_deposit),0) into v_total from public.jars where not archived;
  select id into v_catch from public.jars where is_catch_all;
  if p_amount = v_total then
    insert into public.allocations (jar_id, amount, kind, note)
      select id, per_deposit, 'auto_split', coalesce(p_note,'Jar funding') from public.jars
      where not archived and per_deposit > 0;
    return 'split';
  else
    insert into public.allocations (jar_id, amount, kind, note) values (v_catch, p_amount, 'manual', coalesce(p_note,'Deposit'));
    return 'catch_all';
  end if;
end $$;

revoke execute on function public.jar_move(uuid,uuid,numeric,text), public.jar_withdraw(uuid,numeric,text), public.jar_record_deposit(numeric,text), public.jar_balance(uuid) from anon, public;
grant execute on function public.jar_move(uuid,uuid,numeric,text), public.jar_withdraw(uuid,numeric,text), public.jar_record_deposit(numeric,text), public.jar_balance(uuid) to authenticated;
