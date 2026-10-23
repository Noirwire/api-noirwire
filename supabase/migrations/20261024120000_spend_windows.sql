-- Spend windows: the counters of the caps that bound real spend.
--
-- The API counts most of its limits in memory, which a deploy or a crash
-- empties. The few caps that bound what this service spends (the day's
-- profile creations, the relayer's signatures per minute and per hour) are
-- counted here instead, so a restart cannot refill them and two replicas
-- share one count.
--
-- One row is one budget in one fixed window. Nothing here names a person, a
-- session, a portfolio or an address: a budget is a fixed name.
--
-- Like the rewards tables, the table has row level security on and no
-- policy, and only the secret key calls the functions below.

create table public.spend_windows (
  budget text not null,
  window_start timestamptz not null,
  count integer not null check (count >= 0),
  primary key (budget, window_start)
);

create index spend_windows_window_start on public.spend_windows (window_start);

alter table public.spend_windows enable row level security;

revoke all on table public.spend_windows from anon, authenticated;

grant select, insert, update, delete on table public.spend_windows to service_role;

-- Takes one from a budget's window, or none when it already holds p_limit.
-- One statement decides: the row is counted up only while it is under the
-- limit, so two requests at once, or two replicas, cannot pass the cap. A
-- window that ended more than two days ago is dropped on the way.
create function public.spend_take(p_budget text, p_window_start timestamptz, p_limit integer)
returns boolean
language plpgsql
set search_path = ''
as $$
begin
  if p_limit < 1 then
    return false;
  end if;
  delete from public.spend_windows w
  where w.window_start < p_window_start - interval '2 days';
  insert into public.spend_windows as w (budget, window_start, count)
  values (p_budget, p_window_start, 1)
  on conflict (budget, window_start) do update
    set count = w.count + 1
    where w.count < p_limit;
  return found;
end;
$$;

-- Gives back one that spend_take counted, in that exact window and no other,
-- and never below zero.
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
  public.spend_take (text, timestamptz, integer),
  public.spend_refund (text, timestamptz)
from public, anon, authenticated;

grant execute on function
  public.spend_take (text, timestamptz, integer),
  public.spend_refund (text, timestamptz)
to service_role;
