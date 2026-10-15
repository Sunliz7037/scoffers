-- Scoffers initial schema (applied 2026-10-15).
-- Note: the membership check was later moved to private.is_member() in 002.

create table public.members (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  created_at timestamptz not null default now()
);

create table public.accounts (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  mask text not null,
  kind text not null check (kind in ('savings','checking')),
  plaid_account_id text unique,
  current_balance numeric(12,2),
  available_balance numeric(12,2),
  balance_updated_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.jars (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  emoji text,
  mode text not null check (mode in ('goal','stash','fill_spend')),
  per_deposit numeric(12,2) not null default 0 check (per_deposit >= 0),
  target_amount numeric(12,2),
  target_date date,
  is_catch_all boolean not null default false,
  sort_order int not null default 0,
  archived boolean not null default false,
  created_at timestamptz not null default now(),
  constraint goal_needs_target check (mode <> 'goal' or (target_amount is not null and target_date is not null))
);
create unique index one_catch_all on public.jars (is_catch_all) where is_catch_all;

-- amount: positive = money in, negative = money out
create table public.transactions (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id),
  plaid_transaction_id text unique,
  pending_transaction_id text,
  amount numeric(12,2) not null,
  date date not null,
  name text not null,
  merchant text,
  pending boolean not null default false,
  kind text not null default 'regular' check (kind in ('regular','jar_funding','variable_deposit','sweep','jar_withdrawal','other_transfer')),
  needs_review boolean not null default false,
  source text not null default 'manual' check (source in ('manual','plaid')),
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);
create index on public.transactions (account_id, date desc);

-- Jar balances are always the sum of these entries
create table public.allocations (
  id uuid primary key default gen_random_uuid(),
  jar_id uuid not null references public.jars(id),
  amount numeric(12,2) not null,
  transaction_id uuid references public.transactions(id) on delete set null,
  kind text not null check (kind in ('opening','auto_split','manual','withdrawal','move','adjustment')),
  note text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);
create index on public.allocations (jar_id);
create index on public.allocations (transaction_id);

create table public.transfer_rules (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  to_account_id uuid not null references public.accounts(id),
  amount numeric(12,2),
  days_of_month int[] not null default '{}',
  tolerance_days int not null default 3,
  description_hint text,
  action text not null check (action in ('split_jars','start_period','to_catch_all')),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.planned_items (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id),
  name text not null,
  amount numeric(12,2) not null check (amount > 0),
  recurrence text not null check (recurrence in ('one_time','monthly')),
  due_date date not null,
  end_date date,
  merchant_hint text,
  jar_id uuid references public.jars(id),
  archived boolean not null default false,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  constraint monthly_needs_end check (recurrence = 'one_time' or end_date is not null)
);

create table public.planned_matches (
  id uuid primary key default gen_random_uuid(),
  planned_item_id uuid not null references public.planned_items(id) on delete cascade,
  occurrence_date date not null,
  transaction_id uuid references public.transactions(id) on delete set null,
  status text not null default 'paid' check (status in ('paid','skipped')),
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  unique (planned_item_id, occurrence_date)
);

create table public.jar_coverage (
  id uuid primary key default gen_random_uuid(),
  withdrawal_transaction_id uuid not null references public.transactions(id) on delete cascade,
  charge_transaction_id uuid not null references public.transactions(id) on delete cascade,
  amount numeric(12,2) not null check (amount > 0),
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  unique (withdrawal_transaction_id, charge_transaction_id)
);

-- Plaid connections: server-only (no client policies)
create table public.plaid_items (
  id uuid primary key default gen_random_uuid(),
  item_id text unique not null,
  access_token_encrypted text not null,
  institution text,
  cursor text,
  status text not null default 'ok',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create view public.jar_balances with (security_invoker = true) as
  select j.*, coalesce(sum(a.amount), 0)::numeric(12,2) as balance
  from public.jars j left join public.allocations a on a.jar_id = j.id
  group by j.id;

do $$
declare t text;
begin
  foreach t in array array['members','accounts','jars','transactions','allocations','transfer_rules','planned_items','planned_matches','jar_coverage','plaid_items']
  loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;
-- Policies: see 002 (members-only via private.is_member()).
