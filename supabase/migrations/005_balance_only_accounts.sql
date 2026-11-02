-- Balance-only accounts at other banks (e.g. a Citizens high-yield savings account).
-- Scoffers shows their balance; their transactions never touch jars or What's Left.
-- Paste into Supabase → SQL Editor → New query, then Run.

alter table public.accounts drop constraint if exists accounts_kind_check;
alter table public.accounts add constraint accounts_kind_check
  check (kind in ('savings', 'checking', 'balance_only'));

alter table public.accounts add column if not exists institution text;
alter table public.accounts add column if not exists plaid_item_id uuid references public.plaid_items(id) on delete set null;

-- The existing Wells Fargo accounts belong to the first (and so far only) connection.
update public.accounts
  set plaid_item_id = (select id from public.plaid_items order by created_at limit 1),
      institution = coalesce(institution, 'Wells Fargo')
  where kind in ('savings', 'checking') and plaid_account_id is not null and plaid_item_id is null;

-- A savings goal on a balance-only account (the emergency fund), and money that's
-- about to come out of it. Progress = bank balance − upcoming withdrawals.
alter table public.accounts add column if not exists goal_name text;
alter table public.accounts add column if not exists goal_amount numeric(12,2) check (goal_amount is null or goal_amount > 0);
alter table public.accounts add column if not exists goal_date date;

create table if not exists public.account_holds (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  name text not null,
  amount numeric(12,2) not null check (amount > 0),
  due_date date,
  created_by uuid references auth.users(id) default auth.uid(),
  created_at timestamptz not null default now()
);
alter table public.account_holds enable row level security;
drop policy if exists members_all on public.account_holds;
create policy members_all on public.account_holds for all to authenticated
  using (private.is_member()) with check (private.is_member());
