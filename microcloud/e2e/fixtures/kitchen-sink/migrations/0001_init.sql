create table items (
  id serial primary key,
  owner uuid,
  title text not null,
  created_at timestamptz not null default now()
);
create table ticks (id serial primary key, at timestamptz not null default now());
