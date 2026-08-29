create table if not exists game_rooms (
  code text primary key,
  status text not null default 'lobby' check (status in ('lobby', 'reviewing', 'battle', 'finished')),
  final_rules jsonb,
  last_result jsonb,
  created_at timestamptz not null default now()
);

alter table game_rooms add column if not exists last_result jsonb;

create table if not exists game_players (
  id bigint generated always as identity primary key,
  room_code text not null references game_rooms(code) on delete cascade,
  slot smallint not null check (slot in (1, 2)),
  token text not null unique,
  name text not null,
  cards jsonb not null default '[]'::jsonb,
  ready boolean not null default false,
  choice text,
  score integer not null default 0,
  created_at timestamptz not null default now(),
  unique (room_code, slot)
);

alter table game_rooms enable row level security;
alter table game_players enable row level security;
