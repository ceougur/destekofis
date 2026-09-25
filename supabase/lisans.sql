-- DestekOfis lisans servisi — veritabanı (Supabase, PostgreSQL 15+).
--
-- Tablolar "lisans" şemasındadır ve API'ye (PostgREST) açık değildir. Dışarıdan yalnızca public şemadaki üç fonksiyon
-- çağrılabilir: lisans_activate ve lisans_check (programın istekleri), lisans_operator (operatör merkezi). Üçü de
-- SECURITY DEFINER çalışır ve ilk parametre olarak API sırrını ister. Sır yalnızca Vercel'deki lisans API'sinde
-- (DESTEKOFIS_API_SECRET) durur; burada SHA-256 özeti saklanır. Operatör parolası bcrypt özetidir; oturumlar sunucu
-- tarafında tutulur (tarayıcı çerezinde yalnızca rastgele belirteç vardır, burada onun özeti).
-- İmza (Ed25519) veritabanında değil Vercel'de atılır: fonksiyonlar imzalanacak iddiaları (claims) döndürür.
--
-- Kurulumdan sonra ayarlar (değerler depoya girmez):
--   insert into lisans.settings (key, value) values
--     ('api_secret_sha256', encode(sha256(convert_to('<API sırrı>', 'UTF8')), 'hex')),
--     ('operator_password', '<bcrypt özeti>');

create schema if not exists lisans;
revoke all on schema lisans from public;

-- ---------- Tablolar ----------
create table if not exists lisans.settings (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

-- Programı kullanan bilgisayarlar (kurulumlar). Deneme bilgisayar başına bir kez verilir.
create table if not exists lisans.installations (
  machine text primary key check (machine ~ '^[0-9a-f]{32}$'),
  instance_id text not null default '',
  version text not null default '',
  office_name text not null default '',
  contact text not null default '',
  email text not null default '',
  phone text not null default '',
  note text not null default '',
  first_seen timestamptz not null default now(),
  last_seen timestamptz,
  last_check_at timestamptz,
  last_ip text not null default '',
  trial_id text unique,
  trial_started_at timestamptz,
  trial_expires_at timestamptz,
  trial_status text not null default 'active' check (trial_status in ('active', 'blocked')),
  trial_message text not null default ''
);

create table if not exists lisans.licenses (
  id text primary key,
  key text not null unique check (key ~ '^DO(-[0-9A-HJKMNP-TV-Z]{5}){4}$'),
  customer text not null default '',
  contact text not null default '',
  email text not null default '',
  phone text not null default '',
  note text not null default '',
  status text not null default 'active' check (status in ('active', 'blocked')),
  message text not null default '',
  expires_at timestamptz,
  offline boolean not null default false,
  machine text check (machine ~ '^[0-9a-f]{32}$'),
  activated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists licenses_machine_idx on lisans.licenses (machine) where machine is not null;

-- Lisansın hangi bilgisayarlara bağlandığının geçmişi (taşınan lisansın eski bilgisayarına durdurma bildirmek için).
create table if not exists lisans.license_bindings (
  id bigint generated always as identity primary key,
  license_id text not null references lisans.licenses (id) on delete cascade,
  machine text not null,
  bound_at timestamptz not null default now(),
  released_at timestamptz
);
create index if not exists license_bindings_idx on lisans.license_bindings (license_id, machine);

create table if not exists lisans.events (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  type text not null,
  actor text not null default 'servis',
  machine text,
  license_id text,
  ip text not null default '',
  detail jsonb not null default '{}'::jsonb
);
create index if not exists events_at_idx on lisans.events (at desc);
create index if not exists events_machine_idx on lisans.events (machine, at desc);
create index if not exists events_license_idx on lisans.events (license_id, at desc);
create index if not exists events_ip_idx on lisans.events (ip, type, at desc);

create table if not exists lisans.sessions (
  token_hash text primary key,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  last_seen timestamptz not null default now(),
  ip text not null default ''
);

alter table lisans.settings enable row level security;
alter table lisans.installations enable row level security;
alter table lisans.licenses enable row level security;
alter table lisans.license_bindings enable row level security;
alter table lisans.events enable row level security;
alter table lisans.sessions enable row level security;
revoke all on all tables in schema lisans from public;
revoke all on all sequences in schema lisans from public;

-- ---------- Yardımcılar ----------
create or replace function lisans.iso(t timestamptz) returns text
language sql immutable set search_path = '' as $$
  select case when t is null then null else to_char(t at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end
$$;

create or replace function lisans.setting(p_key text, p_default text default null) returns text
language sql stable set search_path = '' as $$
  select coalesce((select s.value from lisans.settings s where s.key = p_key), p_default)
$$;

create or replace function lisans.sha256_hex(p text) returns text
language sql immutable set search_path = '' as $$
  select encode(pg_catalog.sha256(convert_to(coalesce(p, ''), 'UTF8')), 'hex')
$$;

create or replace function lisans.authorized(p_secret text) returns boolean
language sql stable set search_path = '' as $$
  select p_secret is not null and length(p_secret) >= 32
     and lisans.sha256_hex(p_secret) = lisans.setting('api_secret_sha256', '-')
$$;

create or replace function lisans.reject(p_code text, p_error text, p_status int default 409) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object('ok', false, 'code', p_code, 'error', p_error, 'status', p_status)
$$;

create or replace function lisans.txt(p_args jsonb, p_key text, p_max int) returns text
language sql immutable set search_path = '' as $$
  select left(btrim(coalesce(p_args ->> p_key, '')), p_max)
$$;

create or replace function lisans.machine_of(p text) returns text
language sql immutable set search_path = '' as $$
  select case when x ~ '^[0-9a-f]{32}$' then x end
  from (select lower(regexp_replace(coalesce(p, ''), '[[:space:]-]', '', 'g')) as x) v
$$;

create or replace function lisans.time_of(p text) returns timestamptz
language plpgsql stable set search_path = '' as $$
begin
  if p is null or btrim(p) = '' then return null; end if;
  return p::timestamptz;
exception when others then
  raise exception 'Tarih okunamadı: %', p;
end $$;

create or replace function lisans.new_id(p_prefix text) returns text
language sql volatile set search_path = '' as $$
  select p_prefix || '-' || to_char(now() at time zone 'UTC', 'YYYYMMDD') || '-' || upper(encode(extensions.gen_random_bytes(4), 'hex'))
$$;

-- Lisans anahtarı: DO-XXXXX-XXXXX-XXXXX-XXXXX (Crockford base32; O/I/L/U yok, elle yazımda karışmaz).
create or replace function lisans.new_key() returns text
language plpgsql volatile set search_path = '' as $$
declare
  alphabet constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  b bytea := extensions.gen_random_bytes(20);
  s text := '';
begin
  for i in 0..19 loop
    s := s || substr(alphabet, (get_byte(b, i) % 32) + 1, 1);
  end loop;
  return 'DO-' || substr(s, 1, 5) || '-' || substr(s, 6, 5) || '-' || substr(s, 11, 5) || '-' || substr(s, 16, 5);
end $$;

create or replace function lisans.log(p_type text, p_actor text, p_machine text, p_license text, p_ip text, p_detail jsonb default '{}'::jsonb) returns void
language sql volatile set search_path = '' as $$
  insert into lisans.events (type, actor, machine, license_id, ip, detail)
  values (p_type, p_actor, p_machine, p_license, coalesce(p_ip, ''), coalesce(p_detail, '{}'::jsonb))
$$;

-- Bir bilgisayara bağlı lisanslardan geçerli olanı (yoksa en son olanı) seçer; p_prefer istenen lisanstır.
create or replace function lisans.best_license(p_machine text, p_prefer text default null) returns setof lisans.licenses
language sql stable set search_path = '' as $$
  select l.* from lisans.licenses l
  where l.machine = p_machine
  order by (l.status = 'active' and (l.expires_at is null or l.expires_at > now())) desc,
           (l.id = p_prefer) desc nulls last,
           l.expires_at desc nulls first,
           l.created_at desc
  limit 1
$$;

create or replace function lisans.trial_claims(i lisans.installations) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'schema', 1, 'product', 'DestekOfis', 'type', 'license-token', 'kind', 'trial',
    'status', i.trial_status, 'licenseId', i.trial_id, 'customer', left(i.office_name, 120), 'machine', i.machine,
    'issuedAt', lisans.iso(now()), 'startsAt', lisans.iso(i.trial_started_at), 'expiresAt', lisans.iso(i.trial_expires_at),
    'offline', false, 'message', left(i.trial_message, 300))
$$;

create or replace function lisans.license_claims(l lisans.licenses, p_machine text default null, p_status text default null, p_message text default null) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'schema', 1, 'product', 'DestekOfis', 'type', 'license-token', 'kind', 'license',
    'status', coalesce(p_status, l.status), 'licenseId', l.id, 'customer', left(l.customer, 120),
    'machine', coalesce(p_machine, l.machine), 'issuedAt', lisans.iso(now()),
    'startsAt', lisans.iso(coalesce(l.activated_at, l.created_at)), 'expiresAt', lisans.iso(l.expires_at),
    'offline', l.offline, 'message', left(coalesce(p_message, l.message), 300))
$$;

create or replace function lisans.days_left(p timestamptz) returns int
language sql stable set search_path = '' as $$
  select case when p is null then null else greatest(0, ceil(extract(epoch from (p - now())) / 86400))::int end
$$;

-- Kurulumun durumu: licensed · license_expired · trial · trial_expired · blocked · none
create or replace function lisans.state_of(i lisans.installations, l lisans.licenses) returns text
language sql stable set search_path = '' as $$
  select case
    when l.id is not null then
      case when l.status = 'blocked' then 'blocked'
           when l.expires_at is not null and l.expires_at <= now() then 'license_expired'
           else 'licensed' end
    when i.trial_id is not null then
      case when i.trial_status = 'blocked' then 'blocked'
           when i.trial_expires_at <= now() then 'trial_expired'
           else 'trial' end
    else 'none' end
$$;

create or replace function lisans.license_json(l lisans.licenses) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', l.id, 'key', l.key, 'customer', l.customer, 'contact', l.contact, 'email', l.email, 'phone', l.phone,
    'note', l.note, 'status', l.status, 'message', l.message, 'expiresAt', lisans.iso(l.expires_at), 'offline', l.offline,
    'machine', l.machine, 'activatedAt', lisans.iso(l.activated_at), 'createdAt', lisans.iso(l.created_at),
    'updatedAt', lisans.iso(l.updated_at), 'daysLeft', lisans.days_left(l.expires_at),
    'state', case when l.status = 'blocked' then 'blocked'
                  when l.expires_at is not null and l.expires_at <= now() then 'expired'
                  when l.machine is null then 'unused'
                  else 'active' end,
    'everBound', exists (select 1 from lisans.license_bindings b where b.license_id = l.id),
    'installation', (select jsonb_build_object('officeName', i.office_name, 'lastSeen', lisans.iso(i.last_seen), 'version', i.version)
                     from lisans.installations i where i.machine = l.machine))
$$;

create or replace function lisans.installation_json(i lisans.installations, l lisans.licenses) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'machine', i.machine, 'officeName', i.office_name, 'contact', i.contact, 'email', i.email, 'phone', i.phone,
    'note', i.note, 'version', i.version, 'firstSeen', lisans.iso(i.first_seen), 'lastSeen', lisans.iso(i.last_seen),
    'lastCheckAt', lisans.iso(i.last_check_at),
    'trial', case when i.trial_id is null then null else jsonb_build_object(
      'id', i.trial_id, 'startedAt', lisans.iso(i.trial_started_at), 'expiresAt', lisans.iso(i.trial_expires_at),
      'status', i.trial_status, 'message', i.trial_message, 'daysLeft', lisans.days_left(i.trial_expires_at)) end,
    'license', case when l.id is null then null else jsonb_build_object(
      'id', l.id, 'key', l.key, 'customer', l.customer, 'status', l.status, 'expiresAt', lisans.iso(l.expires_at),
      'offline', l.offline, 'daysLeft', lisans.days_left(l.expires_at)) end,
    'state', lisans.state_of(i, l))
$$;

-- Bir kurulum kaydını oluşturur ya da görüldü bilgisini tazeler.
create or replace function lisans.touch(p_machine text, p_body jsonb, p_ip text, p_office text default '') returns lisans.installations
language plpgsql volatile set search_path = '' as $$
declare
  inst lisans.installations;
begin
  insert into lisans.installations as t (machine, instance_id, version, last_ip, office_name, last_seen)
  values (p_machine, lisans.txt(p_body, 'instanceId', 80), lisans.txt(p_body, 'version', 20), coalesce(p_ip, ''), left(coalesce(p_office, ''), 120), now())
  on conflict (machine) do update set
    last_seen = now(),
    last_ip = excluded.last_ip,
    instance_id = case when excluded.instance_id <> '' then excluded.instance_id else t.instance_id end,
    version = case when excluded.version <> '' then excluded.version else t.version end,
    office_name = case when t.office_name = '' then excluded.office_name else t.office_name end
  returning * into inst;
  return inst;
end $$;

-- Operatörün lisans verdiği bilgisayar henüz kayıtlı değilse ekler (görüldü bilgisine dokunmaz).
create or replace function lisans.ensure_installation(p_machine text, p_office text) returns void
language sql volatile set search_path = '' as $$
  insert into lisans.installations as t (machine, office_name) values (p_machine, left(coalesce(p_office, ''), 120))
  on conflict (machine) do update set office_name = case when t.office_name = '' then excluded.office_name else t.office_name end
$$;

-- ---------- Program: etkinleştirme (deneme veya lisans anahtarı) ----------
create or replace function public.lisans_activate(p_secret text, p_body jsonb, p_ip text default '') returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  m text;
  k text;
  new_trial text;
  recent int;
  days int;
  office jsonb;
  inst lisans.installations;
  lic lisans.licenses;
begin
  if not lisans.authorized(p_secret) then
    return lisans.reject('UNAUTHORIZED', 'Yetkisiz istek.', 401);
  end if;
  if p_body is null or jsonb_typeof(p_body) <> 'object' or p_body ->> 'product' is distinct from 'DestekOfis' then
    return lisans.reject('BAD_REQUEST', 'Geçersiz istek.', 400);
  end if;
  m := lisans.machine_of(p_body ->> 'machine');
  if m is null then
    return lisans.reject('BAD_REQUEST', 'Geçersiz istek.', 400);
  end if;

  if p_body ->> 'kind' = 'trial' then
    select * into inst from lisans.installations where machine = m for update;
    if inst.trial_id is null then
      select count(*) into recent from lisans.events
      where ip = coalesce(p_ip, '') and type = 'trial.started' and at > now() - interval '1 day';
      if coalesce(p_ip, '') <> '' and recent >= lisans.setting('trial_per_ip_per_day', '5')::int then
        perform lisans.log('trial.rate_limited', 'servis', m, null, p_ip);
        return lisans.reject('RATE_LIMITED', 'Çok sık deneme yapıldı.', 429);
      end if;
    end if;
    days := lisans.setting('trial_days', '30')::int;
    office := case when jsonb_typeof(p_body -> 'office') = 'object' then p_body -> 'office' else '{}'::jsonb end;
    new_trial := lisans.new_id('DEN');
    insert into lisans.installations as t (machine, instance_id, version, last_ip, office_name, contact, email, phone,
                                           trial_id, trial_started_at, trial_expires_at, last_seen)
    values (m, lisans.txt(p_body, 'instanceId', 80), lisans.txt(p_body, 'version', 20), coalesce(p_ip, ''),
            lisans.txt(office, 'name', 120), lisans.txt(office, 'contact', 120), lisans.txt(office, 'email', 160),
            lisans.txt(office, 'phone', 40), new_trial, now(), now() + make_interval(days => days), now())
    on conflict (machine) do update set
      last_seen = now(),
      last_ip = excluded.last_ip,
      instance_id = case when excluded.instance_id <> '' then excluded.instance_id else t.instance_id end,
      version = case when excluded.version <> '' then excluded.version else t.version end,
      office_name = case when t.trial_id is null and excluded.office_name <> '' then excluded.office_name else t.office_name end,
      contact = case when t.trial_id is null and excluded.contact <> '' then excluded.contact else t.contact end,
      email = case when t.trial_id is null and excluded.email <> '' then excluded.email else t.email end,
      phone = case when t.trial_id is null and excluded.phone <> '' then excluded.phone else t.phone end,
      trial_id = coalesce(t.trial_id, excluded.trial_id),
      trial_started_at = coalesce(t.trial_started_at, excluded.trial_started_at),
      trial_expires_at = coalesce(t.trial_expires_at, excluded.trial_expires_at)
    returning * into inst;
    if inst.trial_id = new_trial then
      perform lisans.log('trial.started', 'servis', m, inst.trial_id, p_ip, jsonb_build_object(
        'office', inst.office_name, 'contact', inst.contact, 'email', inst.email, 'phone', inst.phone,
        'version', inst.version, 'expiresAt', lisans.iso(inst.trial_expires_at)));
    else
      perform lisans.log('trial.repeated', 'servis', m, inst.trial_id, p_ip);
    end if;
    return jsonb_build_object('ok', true, 'claims', lisans.trial_claims(inst));
  end if;

  if p_body ->> 'kind' = 'license' then
    k := p_body ->> 'licenseKey';
    select count(*) into recent from lisans.events
    where ip = coalesce(p_ip, '') and type = 'license.not_found' and at > now() - interval '1 hour';
    if coalesce(p_ip, '') <> '' and recent >= 10 then
      return lisans.reject('RATE_LIMITED', 'Çok sık deneme yapıldı.', 429);
    end if;
    select * into lic from lisans.licenses where key = k for update;
    if lic.id is null then
      perform lisans.log('license.not_found', 'servis', m, null, p_ip, jsonb_build_object('keyEnd', right(coalesce(k, ''), 5)));
      return lisans.reject('LICENSE_NOT_FOUND', 'Lisans anahtarı bulunamadı.');
    end if;
    if lic.status = 'blocked' then
      perform lisans.log('license.rejected', 'servis', m, lic.id, p_ip, jsonb_build_object('reason', 'blocked'));
      return lisans.reject('LICENSE_BLOCKED', coalesce(nullif(lic.message, ''), 'Bu lisans engellenmiş.'));
    end if;
    if lic.expires_at is not null and lic.expires_at <= now() then
      perform lisans.log('license.rejected', 'servis', m, lic.id, p_ip, jsonb_build_object('reason', 'expired'));
      return lisans.reject('LICENSE_EXPIRED', 'Bu lisansın süresi dolmuş.');
    end if;
    if lic.machine is not null and lic.machine <> m then
      perform lisans.log('license.rejected', 'servis', m, lic.id, p_ip, jsonb_build_object('reason', 'in_use', 'boundTo', lic.machine));
      return lisans.reject('LICENSE_IN_USE', 'Bu lisans başka bir bilgisayarda etkin.');
    end if;
    perform lisans.touch(m, p_body, p_ip, lic.customer);
    if lic.machine is null then
      update lisans.licenses set machine = m, activated_at = now(), updated_at = now() where id = lic.id returning * into lic;
      insert into lisans.license_bindings (license_id, machine) values (lic.id, m);
      perform lisans.log('license.activated', 'servis', m, lic.id, p_ip, jsonb_build_object('customer', lic.customer));
    else
      perform lisans.log('license.reactivated', 'servis', m, lic.id, p_ip);
    end if;
    return jsonb_build_object('ok', true, 'claims', lisans.license_claims(lic));
  end if;

  return lisans.reject('BAD_REQUEST', 'Geçersiz lisans türü.', 400);
end $$;

-- ---------- Program: düzenli doğrulama ----------
-- Bilgisayara bağlı geçerli bir lisans varsa (operatörün panelden verdiği dahil) o döner; yoksa deneme. Lisans başka
-- bilgisayara taşındıysa eski bilgisayara "engellendi" durumlu belirteç döner (program salt okunur olur).
create or replace function public.lisans_check(p_secret text, p_body jsonb, p_ip text default '') returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  m text;
  lid text;
  inst lisans.installations;
  lic lisans.licenses;
begin
  if not lisans.authorized(p_secret) then
    return lisans.reject('UNAUTHORIZED', 'Yetkisiz istek.', 401);
  end if;
  m := lisans.machine_of(p_body ->> 'machine');
  lid := p_body ->> 'licenseId';
  if p_body ->> 'product' is distinct from 'DestekOfis' or m is null or lid is null or lid = '' then
    return lisans.reject('BAD_REQUEST', 'Geçersiz istek.', 400);
  end if;

  update lisans.installations set
    last_seen = now(), last_check_at = now(), last_ip = coalesce(p_ip, ''),
    version = coalesce(nullif(lisans.txt(p_body, 'version', 20), ''), version),
    instance_id = coalesce(nullif(lisans.txt(p_body, 'instanceId', 80), ''), instance_id)
  where machine = m
  returning * into inst;

  -- Denemenin 3. gününde program firma ve iletişim bilgisini doğrulama isteğiyle gönderir.
  if inst.machine is not null and jsonb_typeof(p_body -> 'office') = 'object' and lisans.txt(p_body -> 'office', 'name', 120) <> '' then
    update lisans.installations set
      office_name = lisans.txt(p_body -> 'office', 'name', 120),
      contact = coalesce(nullif(lisans.txt(p_body -> 'office', 'contact', 120), ''), contact),
      email = coalesce(nullif(lisans.txt(p_body -> 'office', 'email', 160), ''), email),
      phone = coalesce(nullif(lisans.txt(p_body -> 'office', 'phone', 40), ''), phone)
    where machine = m
    returning * into inst;
    perform lisans.log('installation.contact', 'servis', m, lid, p_ip, jsonb_build_object(
      'office', inst.office_name, 'contact', inst.contact, 'email', inst.email, 'phone', inst.phone));
  end if;

  select * into lic from lisans.best_license(m, lid);
  if lic.id is not null then
    if inst.machine is null then
      inst := lisans.touch(m, p_body, p_ip, lic.customer);
      update lisans.installations set last_check_at = now() where machine = m;
    end if;
    if lic.id <> lid and not exists (select 1 from lisans.events e where e.machine = m and e.license_id = lic.id
                                     and e.type = 'license.delivered' and e.at > now() - interval '1 day') then
      perform lisans.log('license.delivered', 'servis', m, lic.id, p_ip, jsonb_build_object('previous', lid));
    end if;
    return jsonb_build_object('ok', true, 'claims', lisans.license_claims(lic));
  end if;

  if inst.trial_id is not null and inst.trial_id = lid then
    return jsonb_build_object('ok', true, 'claims', lisans.trial_claims(inst));
  end if;

  select * into lic from lisans.licenses where id = lid;
  if lic.id is not null and exists (select 1 from lisans.license_bindings b where b.license_id = lid and b.machine = m) then
    if not exists (select 1 from lisans.events e where e.machine = m and e.license_id = lid and e.type = 'license.stop_sent' and e.at > now() - interval '1 day') then
      perform lisans.log('license.stop_sent', 'servis', m, lid, p_ip);
    end if;
    return jsonb_build_object('ok', true, 'claims', lisans.license_claims(lic, m, 'blocked',
      'Bu lisans bu bilgisayardan kaldırıldı (başka bir bilgisayara taşındı).'));
  end if;

  if not exists (select 1 from lisans.events e where e.machine = m and e.type = 'check.unknown' and e.at > now() - interval '1 day') then
    perform lisans.log('check.unknown', 'servis', m, lid, p_ip);
  end if;
  return lisans.reject('LICENSE_NOT_FOUND', 'Lisans bulunamadı.');
end $$;

-- ---------- Operatör işlemleri ----------
create or replace function lisans.op_login(p_password text, p_ip text) returns jsonb
language plpgsql volatile set search_path = '' as $$
declare
  h text;
  fails_ip int;
  fails_all int;
  token text;
begin
  select count(*) filter (where ip = coalesce(p_ip, '')), count(*) into fails_ip, fails_all
  from lisans.events where type = 'operator.login_failed' and at > now() - interval '15 minutes';
  if fails_ip >= 5 or fails_all >= 100 then
    return lisans.reject('LOCKED', 'Çok fazla hatalı deneme yapıldı. 15 dakika sonra tekrar deneyin.', 429);
  end if;
  h := lisans.setting('operator_password');
  if h is null or p_password is null or p_password = '' or extensions.crypt(p_password, h) <> h then
    perform lisans.log('operator.login_failed', 'operator', null, null, p_ip);
    return lisans.reject('PASSWORD', 'Parola yanlış.', 401);
  end if;
  token := encode(extensions.gen_random_bytes(32), 'hex');
  delete from lisans.sessions where expires_at < now();
  insert into lisans.sessions (token_hash, expires_at, ip) values (lisans.sha256_hex(token), now() + interval '12 hours', coalesce(p_ip, ''));
  perform lisans.log('operator.login', 'operator', null, null, p_ip);
  return jsonb_build_object('ok', true, 'token', token, 'expiresAt', lisans.iso(now() + interval '12 hours'));
end $$;

create or replace function lisans.op_overview() returns jsonb
language sql stable set search_path = '' as $$
  with inst as (
    select i.*, lisans.state_of(i, l) as st, l.expires_at as lic_expires
    from lisans.installations i
    left join lateral lisans.best_license(i.machine) l on true
  )
  select jsonb_build_object(
    'ok', true,
    'counts', (select jsonb_build_object(
      'installations', count(*),
      'seenLast7Days', count(*) filter (where last_seen > now() - interval '7 days'),
      'trial', count(*) filter (where st = 'trial'),
      'trialEndingSoon', count(*) filter (where st = 'trial' and trial_expires_at <= now() + interval '7 days'),
      'trialExpired', count(*) filter (where st = 'trial_expired'),
      'licensed', count(*) filter (where st = 'licensed'),
      'licenseExpired', count(*) filter (where st = 'license_expired'),
      'blocked', count(*) filter (where st = 'blocked')) from inst),
    'unusedLicenses', (select count(*) from lisans.licenses l where l.machine is null and l.status = 'active'
                        and (l.expires_at is null or l.expires_at > now())),
    'attention', coalesce((select jsonb_agg(a order by a ->> 'date') from (
      select jsonb_build_object(
        'kind', case st when 'trial' then 'trial_ending' when 'trial_expired' then 'trial_expired'
                        when 'licensed' then 'license_ending' else 'license_expired' end,
        'machine', machine, 'officeName', office_name, 'contact', contact, 'phone', phone, 'email', email,
        'date', lisans.iso(case when st in ('trial', 'trial_expired') then trial_expires_at else lic_expires end)) as a
      from inst
      where (st = 'trial' and trial_expires_at <= now() + interval '7 days')
         or (st = 'trial_expired' and trial_expires_at > now() - interval '30 days')
         or (st = 'licensed' and lic_expires is not null and lic_expires <= now() + interval '30 days')
         or (st = 'license_expired' and lic_expires > now() - interval '30 days')
      limit 100) x), '[]'::jsonb),
    'recent', coalesce((select jsonb_agg(e) from (
      select jsonb_build_object('id', ev.id, 'at', lisans.iso(ev.at), 'type', ev.type, 'actor', ev.actor,
                                'machine', ev.machine, 'licenseId', ev.license_id, 'detail', ev.detail,
                                'officeName', coalesce(nullif(i.office_name, ''), lic.customer)) as e
      from lisans.events ev
      left join lisans.installations i on i.machine = ev.machine
      left join lisans.licenses lic on lic.id = ev.license_id
      where ev.type not in ('operator.login', 'operator.logout', 'check.unknown', 'trial.repeated', 'license.reactivated')
      order by ev.at desc limit 12) y), '[]'::jsonb))
$$;

create or replace function lisans.op_installations() returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('ok', true, 'items', coalesce(jsonb_agg(lisans.installation_json(i, l) order by i.last_seen desc nulls last, i.first_seen desc), '[]'::jsonb))
  from lisans.installations i
  left join lateral lisans.best_license(i.machine) l on true
$$;

create or replace function lisans.op_licenses() returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('ok', true, 'items', coalesce(jsonb_agg(lisans.license_json(l) order by l.created_at desc), '[]'::jsonb))
  from lisans.licenses l
$$;

create or replace function lisans.op_events(p_args jsonb) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('ok', true, 'items', coalesce(jsonb_agg(e), '[]'::jsonb)) from (
    select jsonb_build_object('id', ev.id, 'at', lisans.iso(ev.at), 'type', ev.type, 'actor', ev.actor, 'machine', ev.machine,
                              'licenseId', ev.license_id, 'ip', ev.ip, 'detail', ev.detail,
                              'officeName', coalesce(nullif(i.office_name, ''), lic.customer)) as e
    from lisans.events ev
    left join lisans.installations i on i.machine = ev.machine
    left join lisans.licenses lic on lic.id = ev.license_id
    where (p_args ->> 'machine' is null or ev.machine = p_args ->> 'machine')
      and (p_args ->> 'licenseId' is null or ev.license_id = p_args ->> 'licenseId')
    order by ev.at desc
    limit least(greatest(coalesce((p_args ->> 'limit')::int, 300), 1), 1000)) x
$$;

-- Yeni lisans. "machine" verilirse (kurulum kodu) lisans hemen o bilgisayara bağlanır; program bir sonraki
-- doğrulamada lisansı kendiliğinden alır.
create or replace function lisans.op_create_license(p_args jsonb, p_ip text) returns jsonb
language plpgsql volatile set search_path = '' as $$
declare
  m text;
  exp timestamptz;
  lic lisans.licenses;
  attempt int := 0;
begin
  if lisans.txt(p_args, 'customer', 120) = '' then
    raise exception 'Müşteri (ofis) adı gerekli.';
  end if;
  exp := lisans.time_of(p_args ->> 'expiresAt');
  if exp is not null and exp <= now() then
    raise exception 'Bitiş tarihi bugünden sonra olmalı.';
  end if;
  if coalesce(p_args ->> 'machine', '') <> '' then
    m := lisans.machine_of(p_args ->> 'machine');
    if m is null then
      raise exception 'Kurulum kodu geçersiz. 32 karakterli kodu (8 grup) eksiksiz yazın.';
    end if;
  end if;
  loop
    attempt := attempt + 1;
    begin
      insert into lisans.licenses (id, key, customer, contact, email, phone, note, expires_at, offline, machine, activated_at)
      values (lisans.new_id('LIS'), lisans.new_key(), lisans.txt(p_args, 'customer', 120), lisans.txt(p_args, 'contact', 120),
              lisans.txt(p_args, 'email', 160), lisans.txt(p_args, 'phone', 40), lisans.txt(p_args, 'note', 500), exp,
              coalesce((p_args ->> 'offline')::boolean, false), m, case when m is not null then now() end)
      returning * into lic;
      exit;
    exception when unique_violation then
      if attempt >= 5 then raise; end if;
    end;
  end loop;
  if m is not null then
    insert into lisans.license_bindings (license_id, machine) values (lic.id, m);
    perform lisans.ensure_installation(m, lic.customer);
  end if;
  perform lisans.log(case when m is null then 'license.created' else 'license.assigned' end, 'operator', m, lic.id, p_ip,
    jsonb_build_object('customer', lic.customer, 'expiresAt', lisans.iso(lic.expires_at), 'offline', lic.offline));
  return jsonb_build_object('ok', true, 'license', lisans.license_json(lic));
end $$;

create or replace function lisans.op_update_license(p_args jsonb, p_ip text) returns jsonb
language plpgsql volatile set search_path = '' as $$
declare
  old lisans.licenses;
  lic lisans.licenses;
  exp timestamptz;
begin
  select * into old from lisans.licenses where id = p_args ->> 'id' for update;
  if old.id is null then raise exception 'Lisans bulunamadı.'; end if;
  exp := case when p_args ? 'expiresAt' then lisans.time_of(p_args ->> 'expiresAt') else old.expires_at end;
  if p_args ? 'customer' and lisans.txt(p_args, 'customer', 120) = '' then
    raise exception 'Müşteri (ofis) adı boş olamaz.';
  end if;
  update lisans.licenses set
    customer = case when p_args ? 'customer' then lisans.txt(p_args, 'customer', 120) else customer end,
    contact = case when p_args ? 'contact' then lisans.txt(p_args, 'contact', 120) else contact end,
    email = case when p_args ? 'email' then lisans.txt(p_args, 'email', 160) else email end,
    phone = case when p_args ? 'phone' then lisans.txt(p_args, 'phone', 40) else phone end,
    note = case when p_args ? 'note' then lisans.txt(p_args, 'note', 500) else note end,
    message = case when p_args ? 'message' then lisans.txt(p_args, 'message', 300) else message end,
    offline = case when p_args ? 'offline' then coalesce((p_args ->> 'offline')::boolean, false) else offline end,
    expires_at = exp,
    updated_at = now()
  where id = old.id
  returning * into lic;
  if old.expires_at is distinct from lic.expires_at then
    perform lisans.log('license.extended', 'operator', lic.machine, lic.id, p_ip,
      jsonb_build_object('from', lisans.iso(old.expires_at), 'to', lisans.iso(lic.expires_at)));
  end if;
  if (old.customer, old.contact, old.email, old.phone, old.note, old.message, old.offline)
     is distinct from (lic.customer, lic.contact, lic.email, lic.phone, lic.note, lic.message, lic.offline) then
    perform lisans.log('license.updated', 'operator', lic.machine, lic.id, p_ip, jsonb_build_object('customer', lic.customer));
  end if;
  return jsonb_build_object('ok', true, 'license', lisans.license_json(lic));
end $$;

create or replace function lisans.op_set_license_status(p_args jsonb, p_ip text) returns jsonb
language plpgsql volatile set search_path = '' as $$
declare
  lic lisans.licenses;
  st text := p_args ->> 'status';
begin
  if st not in ('active', 'blocked') then raise exception 'Geçersiz durum.'; end if;
  update lisans.licenses set status = st, updated_at = now(),
    message = case when st = 'blocked' then lisans.txt(p_args, 'message', 300) else '' end
  where id = p_args ->> 'id' returning * into lic;
  if lic.id is null then raise exception 'Lisans bulunamadı.'; end if;
  perform lisans.log(case when st = 'blocked' then 'license.blocked' else 'license.unblocked' end, 'operator', lic.machine, lic.id, p_ip,
    jsonb_build_object('message', lic.message));
  return jsonb_build_object('ok', true, 'license', lisans.license_json(lic));
end $$;

-- Lisansı bilgisayardan ayırır (taşıma): anahtar yeni bilgisayarda yeniden etkinleştirilebilir; eski bilgisayar bir
-- sonraki doğrulamada salt okunur olur.
create or replace function lisans.op_release_license(p_args jsonb, p_ip text) returns jsonb
language plpgsql volatile set search_path = '' as $$
declare
  old lisans.licenses;
  lic lisans.licenses;
begin
  select * into old from lisans.licenses where id = p_args ->> 'id' for update;
  if old.id is null then raise exception 'Lisans bulunamadı.'; end if;
  if old.machine is null then raise exception 'Bu lisans zaten hiçbir bilgisayara bağlı değil.'; end if;
  update lisans.licenses set machine = null, activated_at = null, updated_at = now() where id = old.id returning * into lic;
  update lisans.license_bindings set released_at = now() where license_id = old.id and machine = old.machine and released_at is null;
  perform lisans.log('license.released', 'operator', old.machine, old.id, p_ip, '{}'::jsonb);
  return jsonb_build_object('ok', true, 'license', lisans.license_json(lic));
end $$;

create or replace function lisans.op_delete_license(p_args jsonb, p_ip text) returns jsonb
language plpgsql volatile set search_path = '' as $$
declare
  lic lisans.licenses;
begin
  select * into lic from lisans.licenses where id = p_args ->> 'id' for update;
  if lic.id is null then raise exception 'Lisans bulunamadı.'; end if;
  if lic.machine is not null or exists (select 1 from lisans.license_bindings b where b.license_id = lic.id) then
    raise exception 'Kullanılmış bir lisans silinemez. Kullanımı durdurmak için lisansı engelleyin.';
  end if;
  delete from lisans.licenses where id = lic.id;
  perform lisans.log('license.deleted', 'operator', null, lic.id, p_ip, jsonb_build_object('customer', lic.customer));
  return jsonb_build_object('ok', true);
end $$;

-- İnternetsiz etkinleştirme kodu için imzalanacak iddialar. Lisans bir bilgisayara bağlı değilse "machine" (kurulum
-- kodu) ile önce bağlanır.
create or replace function lisans.op_license_code(p_args jsonb, p_ip text) returns jsonb
language plpgsql volatile set search_path = '' as $$
declare
  lic lisans.licenses;
  m text;
begin
  select * into lic from lisans.licenses where id = p_args ->> 'id' for update;
  if lic.id is null then raise exception 'Lisans bulunamadı.'; end if;
  if lic.status <> 'active' then raise exception 'Engelli lisans için kod üretilemez.'; end if;
  if lic.expires_at is not null and lic.expires_at <= now() then raise exception 'Süresi dolmuş lisans için kod üretilemez; önce süreyi uzatın.'; end if;
  if coalesce(p_args ->> 'machine', '') <> '' then
    m := lisans.machine_of(p_args ->> 'machine');
    if m is null then raise exception 'Kurulum kodu geçersiz. 32 karakterli kodu (8 grup) eksiksiz yazın.'; end if;
  end if;
  if lic.machine is null then
    if m is null then raise exception 'Bu lisans henüz bir bilgisayara bağlı değil. Kurulum kodunu yazın.'; end if;
    update lisans.licenses set machine = m, activated_at = now(), updated_at = now() where id = lic.id returning * into lic;
    insert into lisans.license_bindings (license_id, machine) values (lic.id, m);
    perform lisans.ensure_installation(m, lic.customer);
    perform lisans.log('license.assigned', 'operator', m, lic.id, p_ip, jsonb_build_object('customer', lic.customer, 'via', 'code'));
  elsif m is not null and m <> lic.machine then
    raise exception 'Bu lisans başka bir bilgisayara bağlı. Önce "Bilgisayardan ayır" ile ayırın.';
  end if;
  perform lisans.log('license.code_issued', 'operator', lic.machine, lic.id, p_ip, jsonb_build_object('offline', lic.offline));
  return jsonb_build_object('ok', true, 'claims', lisans.license_claims(lic), 'license', lisans.license_json(lic));
end $$;

create or replace function lisans.op_update_installation(p_args jsonb, p_ip text) returns jsonb
language plpgsql volatile set search_path = '' as $$
declare
  inst lisans.installations;
  l lisans.licenses;
begin
  update lisans.installations set
    office_name = case when p_args ? 'officeName' then lisans.txt(p_args, 'officeName', 120) else office_name end,
    contact = case when p_args ? 'contact' then lisans.txt(p_args, 'contact', 120) else contact end,
    email = case when p_args ? 'email' then lisans.txt(p_args, 'email', 160) else email end,
    phone = case when p_args ? 'phone' then lisans.txt(p_args, 'phone', 40) else phone end,
    note = case when p_args ? 'note' then lisans.txt(p_args, 'note', 500) else note end
  where machine = lisans.machine_of(p_args ->> 'machine')
  returning * into inst;
  if inst.machine is null then raise exception 'Kayıt bulunamadı.'; end if;
  perform lisans.log('installation.updated', 'operator', inst.machine, null, p_ip, '{}'::jsonb);
  select * into l from lisans.best_license(inst.machine);
  return jsonb_build_object('ok', true, 'installation', lisans.installation_json(inst, l));
end $$;

-- Deneme süresini değiştirir (uzatma/kısaltma) veya denemeyi engeller / açar.
create or replace function lisans.op_set_trial(p_args jsonb, p_ip text) returns jsonb
language plpgsql volatile set search_path = '' as $$
declare
  old lisans.installations;
  inst lisans.installations;
  l lisans.licenses;
  exp timestamptz;
  st text;
begin
  select * into old from lisans.installations where machine = lisans.machine_of(p_args ->> 'machine') for update;
  if old.machine is null then raise exception 'Kayıt bulunamadı.'; end if;
  if old.trial_id is null then raise exception 'Bu bilgisayarda deneme başlatılmamış.'; end if;
  exp := case when p_args ? 'expiresAt' then lisans.time_of(p_args ->> 'expiresAt') else old.trial_expires_at end;
  if exp is null then raise exception 'Deneme bitiş tarihi gerekli.'; end if;
  st := coalesce(p_args ->> 'status', old.trial_status);
  if st not in ('active', 'blocked') then raise exception 'Geçersiz durum.'; end if;
  update lisans.installations set trial_expires_at = exp, trial_status = st,
    trial_message = case when st = 'blocked' then lisans.txt(p_args, 'message', 300) else '' end
  where machine = old.machine returning * into inst;
  if old.trial_expires_at is distinct from inst.trial_expires_at then
    perform lisans.log('trial.extended', 'operator', inst.machine, inst.trial_id, p_ip,
      jsonb_build_object('from', lisans.iso(old.trial_expires_at), 'to', lisans.iso(inst.trial_expires_at)));
  end if;
  if old.trial_status is distinct from inst.trial_status then
    perform lisans.log(case when st = 'blocked' then 'trial.blocked' else 'trial.unblocked' end, 'operator', inst.machine, inst.trial_id, p_ip,
      jsonb_build_object('message', inst.trial_message));
  end if;
  select * into l from lisans.best_license(inst.machine);
  return jsonb_build_object('ok', true, 'installation', lisans.installation_json(inst, l));
end $$;

-- KVKK: kurulumun kişisel bilgilerini siler (kurulum kodu ve deneme tarihleri kalır; deneme tekrar verilmez).
create or replace function lisans.op_forget_installation(p_args jsonb, p_ip text) returns jsonb
language plpgsql volatile set search_path = '' as $$
declare
  inst lisans.installations;
  l lisans.licenses;
begin
  update lisans.installations set office_name = '', contact = '', email = '', phone = '', last_ip = '',
    note = 'Kişisel bilgiler silindi (KVKK) · ' || to_char(now() at time zone 'Europe/Istanbul', 'DD.MM.YYYY')
  where machine = lisans.machine_of(p_args ->> 'machine')
  returning * into inst;
  if inst.machine is null then raise exception 'Kayıt bulunamadı.'; end if;
  update lisans.events set detail = detail - 'office' - 'contact' - 'email' - 'phone', ip = '' where machine = inst.machine;
  perform lisans.log('installation.forgotten', 'operator', inst.machine, null, p_ip, '{}'::jsonb);
  select * into l from lisans.best_license(inst.machine);
  return jsonb_build_object('ok', true, 'installation', lisans.installation_json(inst, l));
end $$;

create or replace function lisans.op_change_password(p_args jsonb, p_session_hash text, p_ip text) returns jsonb
language plpgsql volatile set search_path = '' as $$
declare
  h text := lisans.setting('operator_password');
  nxt text := coalesce(p_args ->> 'next', '');
begin
  if h is null or extensions.crypt(coalesce(p_args ->> 'current', ''), h) <> h then
    raise exception 'Mevcut parola yanlış.';
  end if;
  if length(nxt) < 8 then raise exception 'Yeni parola en az 8 karakter olmalı.'; end if;
  if length(nxt) > 72 then raise exception 'Yeni parola en fazla 72 karakter olabilir.'; end if;
  update lisans.settings set value = extensions.crypt(nxt, extensions.gen_salt('bf', 10)), updated_at = now() where key = 'operator_password';
  delete from lisans.sessions where token_hash <> p_session_hash;
  perform lisans.log('operator.password_changed', 'operator', null, null, p_ip);
  return jsonb_build_object('ok', true);
end $$;

-- Operatör merkezinin tek giriş noktası. "login" ve "ping" dışındaki işlemler geçerli bir oturum ister.
create or replace function public.lisans_operator(p_secret text, p_session text, p_action text, p_args jsonb default '{}'::jsonb, p_ip text default '') returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  sess lisans.sessions;
  args jsonb := case when jsonb_typeof(p_args) = 'object' then p_args else '{}'::jsonb end;
begin
  if not lisans.authorized(p_secret) then
    return lisans.reject('UNAUTHORIZED', 'Yetkisiz istek.', 401);
  end if;
  if p_action = 'ping' then
    return jsonb_build_object('ok', true, 'time', lisans.iso(now()));
  end if;
  if p_action = 'login' then
    return lisans.op_login(args ->> 'password', p_ip);
  end if;
  select * into sess from lisans.sessions
  where token_hash = lisans.sha256_hex(p_session) and p_session is not null and expires_at > now();
  if sess.token_hash is null then
    return lisans.reject('SESSION', 'Oturumunuz kapandı. Lütfen yeniden giriş yapın.', 401);
  end if;
  update lisans.sessions set last_seen = now() where token_hash = sess.token_hash;
  begin
    case p_action
      when 'me' then
        return jsonb_build_object('ok', true, 'session', jsonb_build_object('createdAt', lisans.iso(sess.created_at), 'expiresAt', lisans.iso(sess.expires_at)));
      when 'logout' then
        delete from lisans.sessions where token_hash = sess.token_hash;
        return jsonb_build_object('ok', true);
      when 'overview' then return lisans.op_overview();
      when 'installations' then return lisans.op_installations();
      when 'licenses' then return lisans.op_licenses();
      when 'events' then return lisans.op_events(args);
      when 'create_license' then return lisans.op_create_license(args, p_ip);
      when 'update_license' then return lisans.op_update_license(args, p_ip);
      when 'set_license_status' then return lisans.op_set_license_status(args, p_ip);
      when 'release_license' then return lisans.op_release_license(args, p_ip);
      when 'delete_license' then return lisans.op_delete_license(args, p_ip);
      when 'license_code' then return lisans.op_license_code(args, p_ip);
      when 'update_installation' then return lisans.op_update_installation(args, p_ip);
      when 'set_trial' then return lisans.op_set_trial(args, p_ip);
      when 'forget_installation' then return lisans.op_forget_installation(args, p_ip);
      when 'change_password' then return lisans.op_change_password(args, sess.token_hash, p_ip);
      else return lisans.reject('BAD_ACTION', 'Bilinmeyen işlem.', 400);
    end case;
  exception
    when raise_exception then return lisans.reject('INVALID', sqlerrm, 400);
    when others then return lisans.reject('DB_ERROR', 'Veritabanı hatası: ' || sqlerrm, 500);
  end;
end $$;

-- ---------- Yetkiler ----------
revoke all on all functions in schema lisans from public;
revoke all on function public.lisans_activate(text, jsonb, text) from public;
revoke all on function public.lisans_check(text, jsonb, text) from public;
revoke all on function public.lisans_operator(text, text, text, jsonb, text) from public;
grant execute on function public.lisans_activate(text, jsonb, text) to anon, service_role;
grant execute on function public.lisans_check(text, jsonb, text) to anon, service_role;
grant execute on function public.lisans_operator(text, text, text, jsonb, text) to anon, service_role;
