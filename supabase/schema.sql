-- ============================================================
-- E-Voting HIMA: skema database (Supabase / PostgreSQL 15+)
-- Jalankan seluruh isi file ini satu kali di Supabase → SQL Editor.
-- Aman dijalankan ulang (idempotent), tidak menghapus data.
-- ============================================================

-- ---------- Tabel ----------

create table if not exists public.settings (
  id              int primary key default 1 check (id = 1),   -- selalu satu baris
  election_name   text not null default 'Pemilihan Wakil Ketua HIMA',
  start_at        timestamptz,
  end_at          timestamptz,
  force_closed    boolean not null default false,              -- tombol darurat
  results_public  boolean not null default false,              -- hasil live terlihat tanpa login
  require_checkin boolean not null default false,              -- pemilih harus diverifikasi panitia dulu
  updated_at      timestamptz not null default now(),
  check (start_at is null or end_at is null or end_at > start_at)
);
insert into public.settings (id) values (1) on conflict (id) do nothing;

create table if not exists public.candidates (
  id         uuid primary key default gen_random_uuid(),
  number     int  not null unique check (number between 1 and 99),
  name       text not null,
  photo      text,                                             -- data URL (jpeg/png/webp)
  vision     text not null default '',
  mission    text not null default '',
  created_at timestamptz not null default now()
);

create table if not exists public.voters (
  id            uuid primary key default gen_random_uuid(),
  nim           text not null unique,
  name          text not null,
  checked_in    boolean not null default false,
  checked_in_at timestamptz,
  has_voted     boolean not null default false,
  voted_at      timestamptz,
  created_at    timestamptz not null default now()
);

-- Suara sengaja TIDAK memuat referensi pemilih maupun waktu,
-- sehingga pilihan tidak bisa ditelusuri ke orangnya.
create table if not exists public.votes (
  id           uuid primary key default gen_random_uuid(),
  candidate_id uuid not null references public.candidates (id) on delete restrict
);

create table if not exists public.audit_log (
  id     bigint generated always as identity primary key,
  at     timestamptz not null default now(),
  actor  text not null,            -- 'admin' | 'voter:<NIM>' | 'system'
  action text not null,
  detail jsonb
);
create index if not exists audit_log_action_at_idx on public.audit_log (action, at desc);

-- Suara bersifat final: tidak boleh diubah (hanya bisa dihapus lewat reset_election).
create or replace function public.votes_block_update() returns trigger
language plpgsql as $$
begin
  raise exception 'Suara tidak dapat diubah';
end $$;

drop trigger if exists votes_immutable on public.votes;
create trigger votes_immutable before update on public.votes
  for each row execute function public.votes_block_update();

-- ---------- Fungsi ----------

-- Mencatat suara secara atomik: cek jadwal, kunci baris pemilih, simpan suara,
-- tandai pemilih sudah memilih, semuanya dalam satu transaksi.
create or replace function public.cast_vote(p_voter_id uuid, p_candidate_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  s settings%rowtype;
  v voters%rowtype;
begin
  select * into s from settings where id = 1;
  if s.force_closed or s.start_at is null or s.end_at is null
     or now() < s.start_at or now() >= s.end_at then
    return 'closed';
  end if;

  select * into v from voters where id = p_voter_id for update;
  if not found then return 'voter_not_found'; end if;
  if v.has_voted then return 'already_voted'; end if;
  if s.require_checkin and not v.checked_in then return 'not_checked_in'; end if;

  if not exists (select 1 from candidates where id = p_candidate_id) then
    return 'candidate_not_found';
  end if;

  insert into votes (candidate_id) values (p_candidate_id);
  update voters set has_voted = true, voted_at = now() where id = p_voter_id;
  insert into audit_log (actor, action) values ('voter:' || v.nim, 'vote_cast');
  return 'ok';
end $$;

-- Rekap suara per kandidat.
create or replace function public.get_results()
returns table (candidate_id uuid, total bigint)
language sql
stable
security definer
set search_path = public
as $$
  select c.id, count(v.id)
  from candidates c
  left join votes v on v.candidate_id = c.id
  group by c.id;
$$;

-- Mengosongkan suara dan status memilih (untuk uji coba). Log audit tetap disimpan.
create or replace function public.reset_election()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from votes where true;
  update voters set has_voted = false, voted_at = null where true;
end $$;

-- ---------- Keamanan ----------
-- Semua akses data lewat Netlify Functions memakai service_role.
-- Kunci anon/authenticated tidak boleh menyentuh apa pun.

alter table public.settings   enable row level security;
alter table public.candidates enable row level security;
alter table public.voters     enable row level security;
alter table public.votes      enable row level security;
alter table public.audit_log  enable row level security;

revoke all on public.settings, public.candidates, public.voters, public.votes, public.audit_log
  from anon, authenticated;

revoke all on function public.cast_vote(uuid, uuid)  from public, anon, authenticated;
revoke all on function public.get_results()          from public, anon, authenticated;
revoke all on function public.reset_election()       from public, anon, authenticated;
grant execute on function public.cast_vote(uuid, uuid) to service_role;
grant execute on function public.get_results()         to service_role;
grant execute on function public.reset_election()      to service_role;
