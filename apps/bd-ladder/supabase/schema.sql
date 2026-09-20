-- BD Ladder · Supabase schema
--
-- Two zones, and the line between them is the point:
--
--   MIRROR  — written only by the sync function, never by the app. Kylas is
--             the system of record for a company and its contacts; Airtable is
--             the system of record for the funnel. Neither is re-derived here.
--   OWNED   — written only by the app. Research, focus and the roster have no
--             home in Kylas or Airtable, so this is where they live.
--
-- The rungs are NOT derived in this database. Ayush, 2026-09-19: the console
-- has been recording every stage change into Airtable's Stage Transitions
-- since it went in, and a second derivation of one rule in a second store is
-- the most expensive bug this codebase has had. The sync reads the answer and
-- copies it; company_rungs.source records where each date came from.

-- ─────────────────────────── mirror ───────────────────────────

create table kylas_users (
  id            bigint primary key,
  name          text not null,
  designation   text,
  active        boolean not null default true,
  synced_at     timestamptz not null default now()
);

create table companies (
  id             bigint primary key,          -- Kylas company id = :id in the route
  name           text not null,
  owner_id       bigint references kylas_users(id),
  owner_name     text,                        -- denormalised: every view groups by BD
  stage          text,                        -- cfPipelineStageBd, as a code
  source         text,                        -- cfSourceOfData
  last_called_on date,                        -- cfLastCalledAtDate, as an IST date
  kylas_updated_at timestamptz,
  synced_at      timestamptz not null default now()
);
create index on companies (owner_id);
create index on companies (stage);

create table contacts (
  id             bigint primary key,          -- Kylas contact id
  company_id     bigint references companies(id) on delete cascade,
  name           text,
  designation    text,
  phone          text,
  email          text,
  last_called_on date,
  stage          text,
  synced_at      timestamptz not null default now()
);
create index on contacts (company_id);

-- One row per company per rung reached. Absent means the rung did not happen:
-- there is no fill-down, so a company whose only date is SQL has exactly one
-- row here and counts at exactly one rung.
create table company_rungs (
  company_id bigint not null references companies(id) on delete cascade,
  rung       smallint not null check (rung between 0 and 5),
  on_date    date not null,
  -- airtable: a real transition in the log.       The date is measured.
  -- observed: the sync itself saw the stage move. Measured, but only since the
  --           sync started watching.
  -- seeded:   inferred from the stage the company is sitting on plus its last
  --           call, because nobody has worked it through the console yet. This
  --           is the majority on day one and the banner says how many.
  source     text not null check (source in ('airtable', 'observed', 'seeded')),
  mode       text,                            -- Stage Transitions.Mode, for rungs 2 and 4
  primary key (company_id, rung)
);

-- Why an account stopped moving, mirrored from Airtable's RCA table. One open
-- question per contact per gate; the gates live in docs/rca-reasons.json.
create table rca_answers (
  id           text primary key,              -- "<kylas contact id>|<gate key>"
  company_id   bigint references companies(id) on delete cascade,
  gate         text not null,
  reason       text,                          -- null until answered
  note         text,
  stuck_since  timestamptz,
  stuck_days   integer,
  answered_at  timestamptz,
  answered_by  text,
  owner_name   text,
  synced_at    timestamptz not null default now()
);
create index on rca_answers (company_id);

-- ─────────────────────────── owned by the app ───────────────────────────

create table research (
  company_id   bigint primary key references companies(id) on delete cascade,
  -- the reference's fifteen, in its order. `decides` and `trigger_note` are
  -- renamed from the prototype's `dm` and `trigger`: `trigger` is reserved in
  -- Postgres, and `dm` says nothing.
  industry text, size text, hq text, offices text, funding text, revenue text,
  events text, season text, decides text, vendor text, trigger_note text,
  links text, v text, w text, notes text,
  updated_by       uuid references auth.users(id),
  updated_by_email text,
  updated_at       timestamptz not null default now()
);

create table focus (
  company_id   bigint primary key references companies(id) on delete cascade,
  status       text not null check (status in ('focus', 'depri')),
  reason       text,
  note         text,
  -- whose list it is, snapshot at set time. Kept apart from set_by because
  -- Kylas ownership goes stale and the list should not move under the BD.
  owner_name   text,
  set_by       uuid references auth.users(id),
  set_by_email text,
  set_at       timestamptz not null default now()
);

-- Append-only. Never updated, never deleted: the point of the focus list is
-- what a BD decided and when, and an overwrite loses exactly that.
create table focus_history (
  id           bigserial primary key,
  company_id   bigint not null,
  from_status  text,
  to_status    text not null check (to_status in ('focus', 'normal', 'depri')),
  reason       text,
  note         text,
  set_by       uuid,
  set_by_email text,
  at           timestamptz not null default now()
);
create index on focus_history (company_id, at desc);

-- Who counts as an active BDA, when Kylas has it wrong. Null means "no
-- override" — the mirror's value stands.
create table roster_overrides (
  user_id          bigint primary key references kylas_users(id),
  designation      text,
  active           boolean,
  updated_by       uuid references auth.users(id),
  updated_by_email text,
  updated_at       timestamptz not null default now()
);

create table sync_runs (
  id           bigserial primary key,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  status       text not null check (status in ('running', 'ok', 'failed')),
  companies    integer, contacts integer, users integer, rungs integer,
  error        text,
  triggered_by text                           -- 'cron', or the email that pressed Sync now
);

-- ─────────────────────────── who may read and write ───────────────────────────
--
-- Google's `hd` parameter is a hint to the sign-in screen, not a control: it
-- can be removed from the URL. The predicate below is the actual enforcement,
-- and it is on every table rather than on a view somebody might bypass.

create or replace function is_enout() returns boolean
language sql stable as $$
  select coalesce(auth.jwt() ->> 'email', '') like '%@enout.in'
$$;

alter table kylas_users     enable row level security;
alter table companies       enable row level security;
alter table contacts        enable row level security;
alter table company_rungs   enable row level security;
alter table rca_answers     enable row level security;
alter table research        enable row level security;
alter table focus           enable row level security;
alter table focus_history   enable row level security;
alter table roster_overrides enable row level security;
alter table sync_runs       enable row level security;

-- Read: anybody at Enout.
do $$
declare t text;
begin
  foreach t in array array['kylas_users','companies','contacts','company_rungs','rca_answers',
                           'research','focus','focus_history','roster_overrides','sync_runs']
  loop
    execute format('create policy %I_read on %I for select using (is_enout())', t, t);
  end loop;
end $$;

-- Write: anybody at Enout, on the app's own tables only. Ayush, 2026-09-19:
-- any @enout.in user may set focus, because an unowned or wrongly-owned
-- account otherwise cannot be focused by anyone, and ownership is precisely
-- the field that goes stale.
do $$
declare t text;
begin
  foreach t in array array['research','focus','focus_history','roster_overrides']
  loop
    execute format('create policy %I_write on %I for insert with check (is_enout())', t, t);
    execute format('create policy %I_update on %I for update using (is_enout()) with check (is_enout())', t, t);
  end loop;
end $$;

-- focus is the only one a person may clear ("Not picked"). The history is not
-- deletable by anyone: no policy, so RLS denies it.
create policy focus_delete on focus for delete using (is_enout());

-- The mirror and the run log are the service role's alone. No write policy is
-- declared for them, so RLS denies every write that is not the service key —
-- which is the sync function, and nothing in the browser.
