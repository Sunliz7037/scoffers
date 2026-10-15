-- Scoffers Inbox helpers (applied 2026-10-15).
-- Also applied 2026-10-15 as data (no schema change): Italy's opening balance was
-- recorded as $2,379 saved minus $1,402 already spent on the trip, so goal progress
-- counts money spent from the jar.

create or replace function public.inbox_assign_withdrawal(p_txn uuid, p_jar uuid)
returns void language plpgsql security invoker set search_path = public as $$
declare t public.transactions; b numeric; jname text;
begin
  if not private.is_member() then raise exception 'Not allowed'; end if;
  select * into t from public.transactions where id = p_txn for update;
  if t.id is null then raise exception 'Transaction not found'; end if;
  if t.amount >= 0 then raise exception 'That is a deposit, not a withdrawal'; end if;
  if exists (select 1 from public.allocations where transaction_id = p_txn) then raise exception 'Already assigned'; end if;
  select public.jar_balance(p_jar), name into b, jname from public.jars where id = p_jar;
  if b < -t.amount then raise exception '% only has $%. Move money into it first, or pick another jar.', jname, b; end if;
  insert into public.allocations (jar_id, amount, kind, note, transaction_id)
    values (p_jar, t.amount, 'withdrawal', t.name, p_txn);
  update public.transactions set needs_review = false where id = p_txn;
end $$;

create or replace function public.inbox_label_deposit(p_txn uuid, p_jar uuid)
returns void language plpgsql security invoker set search_path = public as $$
declare t public.transactions; v_catch uuid;
begin
  if not private.is_member() then raise exception 'Not allowed'; end if;
  select * into t from public.transactions where id = p_txn for update;
  if t.id is null then raise exception 'Transaction not found'; end if;
  if t.amount <= 0 then raise exception 'That is a withdrawal, not a deposit'; end if;
  select id into v_catch from public.jars where is_catch_all;
  if p_jar <> v_catch then
    insert into public.allocations (jar_id, amount, kind, note, transaction_id) values
      (v_catch, -t.amount, 'move', 'Labeled: ' || t.name, p_txn),
      (p_jar,    t.amount, 'move', t.name, p_txn);
  end if;
  update public.transactions set needs_review = false where id = p_txn;
end $$;

create or replace function public.inbox_dismiss(p_txn uuid)
returns void language plpgsql security invoker set search_path = public as $$
begin
  if not private.is_member() then raise exception 'Not allowed'; end if;
  update public.transactions set needs_review = false where id = p_txn;
end $$;

revoke execute on function public.inbox_assign_withdrawal(uuid,uuid), public.inbox_label_deposit(uuid,uuid), public.inbox_dismiss(uuid) from anon, public;
grant execute on function public.inbox_assign_withdrawal(uuid,uuid), public.inbox_label_deposit(uuid,uuid), public.inbox_dismiss(uuid) to authenticated;
