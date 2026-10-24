-- Spend windows: the counters of the caps that bound real spend.
--
-- The API counts most of its limits in memory, which a deploy or a crash
-- empties. The few caps that bound what this service spends (the day's
-- profile creations, the relayer's signatures per minute and per hour) are
-- counted here instead, so a restart cannot refill them and two replicas
-- share one count.
--
-- One row is one budget and the window it is counting now. A window starts
-- at the budget's first take after the last one ended, by this database's
-- clock, and is not aligned to the calendar: a caller who spends a whole
-- cap just before a calendar boundary finds the cap still spent just after
-- it. Nothing here names a person, a session, a portfolio or an address: a
-- budget is a fixed name.
--
-- Like the rewards tables, the table has row level security on and no
-- policy, and only the secret key calls the functions below.

create table public.spend_windows (
  budget text primary key,
  window_start timestamptz not null,
  count integer not null check (count >= 0)
);

alter table public.spend_windows enable row level security;

revoke all on table public.spend_windows from anon, authenticated;

grant select, insert, update, delete on table public.spend_windows to service_role;

-- Takes one from a budget, or none when its window is still running and
-- already holds p_limit. One statement decides, under the row's lock, so two
-- requests at once, or two replicas, cannot pass the cap. A window that has
-- run for p_window_ms is over: the take starts a new one at the database's
-- clock with a count of 1. Answers {"taken": true, "window_start": ...} with
-- the window the take was counted in, or {"taken": false}.
create function public.spend_take(p_budget text, p_window_ms integer, p_limit integer)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  started timestamptz;
begin
  if p_limit < 1 or p_window_ms < 1 then
    return jsonb_build_object('taken', false);
  end if;
  insert into public.spend_windows as w (budget, window_start, count)
  values (p_budget, clock_timestamp(), 1)
  on conflict (budget) do update
    set window_start = case
          when w.window_start + p_window_ms * interval '1 millisecond' <= excluded.window_start
          then excluded.window_start
          else w.window_start
        end,
        count = case
          when w.window_start + p_window_ms * interval '1 millisecond' <= excluded.window_start
          then 1
          else w.count + 1
        end
    where w.window_start + p_window_ms * interval '1 millisecond' <= excluded.window_start
      or w.count < p_limit
  returning w.window_start into started;
  if started is null then
    return jsonb_build_object('taken', false);
  end if;
  return jsonb_build_object('taken', true, 'window_start', started);
end;
$$;

-- Gives back one that spend_take counted, in the window it names and no
-- other, and never below zero. A window that has since been replaced is left
-- alone.
create function public.spend_refund(p_budget text, p_window_start timestamptz)
returns void
language sql
set search_path = ''
as $$
  update public.spend_windows w
  set count = w.count - 1
  where w.budget = p_budget and w.window_start = p_window_start and w.count > 0
$$;

revoke execute on function
  public.spend_take (text, integer, integer),
  public.spend_refund (text, timestamptz)
from public, anon, authenticated;

grant execute on function
  public.spend_take (text, integer, integer),
  public.spend_refund (text, timestamptz)
to service_role;
