-- Rewards: opt-in points for trades.
--
-- A member is a rewards key, which is not a wallet address. Nothing here has
-- a column for a portfolio, a transaction, a session, an address or a time
-- of day: a claimed transaction is remembered by a keyed fingerprint alone.
--
-- Every table has row level security on and no policy, so only the secret
-- key reads or writes. The API reaches them through the functions below and
-- never directly; each function is one atomic step.

create table public.rewards_members (
  rewards_key text primary key,
  code text not null unique,
  invited_by text references public.rewards_members (rewards_key),
  -- The week the member joined in, counted from the season start.
  joined_week integer not null,
  -- The UTC day the member joined on, in days since 1970-01-01: what the
  -- cap on new members per day is counted by.
  joined_day integer not null,
  -- The member's place in the order of joining, from 1. Given once, when
  -- the member is made, and never changed or given again.
  member_number integer not null unique check (member_number > 0)
);

create index rewards_members_invited_by on public.rewards_members (invited_by);
create index rewards_members_joined_day on public.rewards_members (joined_day);

create table public.rewards_week_fees (
  rewards_key text not null references public.rewards_members (rewards_key),
  week integer not null,
  -- What the member's claimed trades of the week really paid.
  fee_micro_usdc bigint not null check (fee_micro_usdc > 0),
  -- What those trades count for toward the week's score: the same, but for
  -- a trade made in the double hour, which counts twice. A member is shown
  -- the first; scores, shares and the settlement use this one.
  counted_micro_usdc bigint not null,
  primary key (rewards_key, week),
  check (counted_micro_usdc >= fee_micro_usdc)
);

create index rewards_week_fees_week on public.rewards_week_fees (week);

-- One row per claimed transaction: HMAC-SHA256 of its signature under a
-- secret only the API holds.
create table public.rewards_claims (
  fingerprint text primary key
);

-- A week is here once its points have been handed out.
create table public.rewards_settled_weeks (
  week integer primary key
);

create table public.rewards_points (
  rewards_key text not null references public.rewards_members (rewards_key),
  week integer not null references public.rewards_settled_weeks (week),
  points bigint not null check (points > 0),
  primary key (rewards_key, week)
);

alter table public.rewards_members enable row level security;
alter table public.rewards_week_fees enable row level security;
alter table public.rewards_claims enable row level security;
alter table public.rewards_settled_weeks enable row level security;
alter table public.rewards_points enable row level security;

revoke all on table
  public.rewards_members,
  public.rewards_week_fees,
  public.rewards_claims,
  public.rewards_settled_weeks,
  public.rewards_points
from anon, authenticated;

grant select, insert, update on table
  public.rewards_members,
  public.rewards_week_fees,
  public.rewards_claims,
  public.rewards_settled_weeks,
  public.rewards_points
to service_role;

-- Every member's score for one week, in tenths of a micro-USDC: their own
-- fees as they are counted (a trade of the double hour twice), times 1.1 while they are an invited member within eight weeks of
-- the week they joined in, plus 0.2 of the fees of the members they
-- invited. A trade made in a week before its member joined, and claimed
-- after, counts once and earns the inviter nothing: an invite is worth
-- something only from the week it was used in.
create function public.rewards_scores(p_week integer)
returns table (rewards_key text, score numeric)
language sql
stable
set search_path = ''
as $$
  with fees as (
    select
      f.rewards_key,
      f.counted_micro_usdc::numeric as fee,
      m.invited_by,
      (m.invited_by is not null and p_week >= m.joined_week) as invited,
      p_week - m.joined_week < 8 as in_first_weeks
    from public.rewards_week_fees f
    join public.rewards_members m on m.rewards_key = f.rewards_key
    where f.week = p_week
  ),
  parts as (
    select
      fees.rewards_key,
      fees.fee * (case when fees.invited and fees.in_first_weeks then 11 else 10 end) as score
    from fees
    union all
    select fees.invited_by, fees.fee * 2
    from fees
    where fees.invited
  )
  select parts.rewards_key, sum(parts.score)
  from parts
  group by parts.rewards_key
$$;

-- Makes a rewards key a member. Joining again changes nothing. An invite
-- code counts only for a new member, and only when it is the code of a
-- member with at least one credited trade; otherwise nothing is created.
--
-- No more than p_daily_join_cap members are made on one UTC day, and each
-- new member is given the next member number. New members are made one at a
-- time, under one lock, so two joins at once can neither pass the cap nor
-- be given one number. A join that is refused, for the cap, its invite code
-- or its own code, takes no number: the numbers have no gap. A key that is
-- already a member is answered as one whatever the count.
create function public.rewards_join(
  p_rewards_key text,
  p_code text,
  p_invite_code text,
  p_joined_week integer,
  p_joined_day integer,
  p_daily_join_cap integer
)
returns text
language plpgsql
set search_path = ''
as $$
declare
  v_inviter text;
begin
  if exists (select 1 from public.rewards_members m where m.rewards_key = p_rewards_key) then
    return 'member';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(7392, 0);
  if exists (select 1 from public.rewards_members m where m.rewards_key = p_rewards_key) then
    return 'member';
  end if;
  if (select count(*) from public.rewards_members m where m.joined_day = p_joined_day)
    >= p_daily_join_cap then
    return 'cap_reached';
  end if;

  if p_invite_code is not null then
    select m.rewards_key into v_inviter
    from public.rewards_members m
    where m.code = p_invite_code
      and exists (select 1 from public.rewards_week_fees f where f.rewards_key = m.rewards_key);
    if v_inviter is null then
      return 'invite_invalid';
    end if;
  end if;

  begin
    insert into public.rewards_members
      (rewards_key, code, invited_by, joined_week, joined_day, member_number)
    select
      p_rewards_key,
      p_code,
      v_inviter,
      p_joined_week,
      p_joined_day,
      coalesce(max(m.member_number), 0) + 1
    from public.rewards_members m;
  exception when unique_violation then
    -- The code is another member's. The insert is undone, and with it the number.
    return 'code_taken';
  end;
  return 'joined';
end;
$$;

-- The two counts every wallet is shown, in one read: how many members there
-- are, and how many of them have a fee credited in one week. A member has
-- one row per week however many trades they claimed in it, and no row holds
-- a fee of zero. These are counts and say nothing of any member. With
-- p_week null, outside the season, no week matches and its count is zero.
create function public.rewards_totals(p_week integer)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'members', (select count(*) from public.rewards_members),
    'week_traders', (select count(*) from public.rewards_week_fees f where f.week = p_week)
  )
$$;

-- A member as of one week, or null when the key has not joined. Outside the
-- season p_week is null: it matches no row, so the week's amounts are zero
-- and the points are returned all the same. Amounts are text, so that none
-- loses digits on the way.
create function public.rewards_state(p_rewards_key text, p_week integer)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'code', m.code,
    'code_active', exists (
      select 1 from public.rewards_week_fees f where f.rewards_key = m.rewards_key
    ),
    'invited', (
      select count(*) from public.rewards_members i where i.invited_by = m.rewards_key
    ),
    'was_invited', m.invited_by is not null,
    'joined_week', m.joined_week,
    'member_number', m.member_number,
    'points', (
      select coalesce(sum(p.points), 0)::text
      from public.rewards_points p
      where p.rewards_key = m.rewards_key
    ),
    'week_fee_micro_usdc', (
      select coalesce(sum(f.fee_micro_usdc), 0)::text
      from public.rewards_week_fees f
      where f.rewards_key = m.rewards_key and f.week = p_week
    ),
    'week_score', (
      select coalesce(sum(s.score), 0)::text
      from public.rewards_scores(p_week) s
      where s.rewards_key = m.rewards_key
    ),
    'week_total_score', (
      select coalesce(sum(s.score), 0)::text from public.rewards_scores(p_week) s
    ),
    'week_traders', (
      select count(*) from public.rewards_week_fees f where f.week = p_week
    )
  )
  from public.rewards_members m
  where m.rewards_key = p_rewards_key
$$;

-- Records a claimed transaction's fingerprint and adds its fee to the
-- member's week, or does neither: a fingerprint already there changes
-- nothing, and so does a week whose points were already handed out.
--
-- The fee is added twice over: as it was paid, and as it counts toward the
-- score. The API works out the second from the transaction's own block
-- time. What was credited stays as it was credited, whatever the double
-- hour is set to later.
--
-- The lock is shared between claims and exclusive to the settlement of the
-- same week, so no fee is added to a week while it is being settled.
create function public.rewards_credit(
  p_rewards_key text,
  p_fingerprint text,
  p_week integer,
  p_fee_micro_usdc bigint,
  p_counted_micro_usdc bigint
)
returns text
language plpgsql
set search_path = ''
as $$
begin
  if not exists (select 1 from public.rewards_members m where m.rewards_key = p_rewards_key) then
    return 'not_member';
  end if;

  perform pg_catalog.pg_advisory_xact_lock_shared(7391, p_week);
  if exists (select 1 from public.rewards_settled_weeks w where w.week = p_week) then
    return 'settled';
  end if;

  insert into public.rewards_claims (fingerprint)
  values (p_fingerprint)
  on conflict do nothing;
  if not found then
    return 'duplicate';
  end if;

  insert into public.rewards_week_fees as f
    (rewards_key, week, fee_micro_usdc, counted_micro_usdc)
  values (p_rewards_key, p_week, p_fee_micro_usdc, p_counted_micro_usdc)
  on conflict (rewards_key, week)
  do update set
    fee_micro_usdc = f.fee_micro_usdc + excluded.fee_micro_usdc,
    counted_micro_usdc = f.counted_micro_usdc + excluded.counted_micro_usdc;
  return 'credited';
end;
$$;

-- Hands out the points of each of the first p_weeks weeks that has not been
-- settled: p_weekly_points split by score, each share rounded down, so the
-- total never exceeds it. A week with no fees hands out nothing. Marking
-- the week and handing out its points are one step, so settling again, or
-- from two requests at once, changes nothing.
create function public.rewards_settle(p_weeks integer, p_weekly_points bigint)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_week integer;
  v_total numeric;
begin
  for v_week in
    select w.week
    from pg_catalog.generate_series(0, p_weeks - 1) as w (week)
    where not exists (select 1 from public.rewards_settled_weeks s where s.week = w.week)
    order by w.week
  loop
    perform pg_catalog.pg_advisory_xact_lock(7391, v_week);
    insert into public.rewards_settled_weeks (week)
    values (v_week)
    on conflict do nothing;
    if found then
      select coalesce(sum(s.score), 0) into v_total from public.rewards_scores(v_week) s;
      if v_total > 0 then
        insert into public.rewards_points (rewards_key, week, points)
        select
          s.rewards_key,
          v_week,
          pg_catalog.div(p_weekly_points * s.score, v_total)::bigint
        from public.rewards_scores(v_week) s
        where pg_catalog.div(p_weekly_points * s.score, v_total) > 0;
      end if;
    end if;
  end loop;
end;
$$;

revoke execute on function
  public.rewards_scores (integer),
  public.rewards_totals (integer),
  public.rewards_join (text, text, text, integer, integer, integer),
  public.rewards_state (text, integer),
  public.rewards_credit (text, text, integer, bigint, bigint),
  public.rewards_settle (integer, bigint)
from public, anon, authenticated;

grant execute on function
  public.rewards_scores (integer),
  public.rewards_totals (integer),
  public.rewards_join (text, text, text, integer, integer, integer),
  public.rewards_state (text, integer),
  public.rewards_credit (text, text, integer, bigint, bigint),
  public.rewards_settle (integer, bigint)
to service_role;
