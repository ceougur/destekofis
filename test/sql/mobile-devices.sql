-- 2.4.7 M2: lisans.licenses.mobile_devices (program başına en çok eşli uzaktan cihaz) — yerel, geçici PostgreSQL'de; canlıya dokunmaz.
-- test/lisans-mobile-sql.test.mjs çalıştırır (lisans.sql koşulduktan sonra). Her ASSERT iletisi başarısız denetimin nedenini söyler.
-- Sonda imzalanacak iddiaları "CLAIMS <ad> <json>" satırlarıyla basar; JS testi onları Vercel'deki signToken ile imzalayıp
-- PROGRAMIN verifyToken'ıyla doğrular.
\set ON_ERROR_STOP 1
insert into lisans.settings (key, value) values ('api_secret_sha256', encode(sha256(convert_to(repeat('s', 40), 'UTF8')), 'hex'))
on conflict (key) do update set value = excluded.value;
insert into lisans.settings (key, value) values ('operator_password', extensions.crypt('operator-parola-1', extensions.gen_salt('bf', 4)))
on conflict (key) do update set value = excluded.value;

create temp table t_ctx as select repeat('s', 40) as secret,
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'::text as m_trial,
  'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'::text as m_key,
  'cccccccccccccccccccccccccccccccc'::text as m_bound;
create temp table t_sess as select public.lisans_operator((select secret from t_ctx), null, 'login', '{"password": "operator-parola-1"}'::jsonb, '') ->> 'token' as token;
create or replace function pg_temp.op(p_action text, p_args jsonb) returns jsonb language sql as $$
  select public.lisans_operator((select secret from t_ctx), (select token from t_sess), p_action, p_args, '10.0.0.9')
$$;

-- 1) Şema: sütun var, NOT NULL, varsayılan 3, 0–100 denetimi; doğrudan sınır dışı yazım reddedilir.
do $$
declare
  col record;
  failed boolean := false;
begin
  assert (select token from t_sess) is not null, 'operatör girişi başarısız';
  select is_nullable, column_default, data_type into col from information_schema.columns
  where table_schema = 'lisans' and table_name = 'licenses' and column_name = 'mobile_devices';
  assert col.data_type = 'integer', 'lisans.licenses.mobile_devices sütunu yok ya da tam sayı değil: ' || coalesce(col.data_type, 'YOK');
  assert col.is_nullable = 'NO', 'mobile_devices NULL alabiliyor';
  assert col.column_default = '3', 'mobile_devices varsayılanı 3 değil: ' || coalesce(col.column_default, 'YOK');
  begin
    insert into lisans.licenses (id, key, customer, mobile_devices) values ('LIS-T-101', 'DO-00000-00000-00000-00001', 'Sınır Dışı', 101);
  exception when check_violation then failed := true;
  end;
  assert failed, 'mobile_devices = 101 doğrudan yazılabildi (CHECK yok)';
end $$;

-- 2) Operatör: oluşturmada varsayılan 3, verilen değer yansır (sayı ya da rakam dizgesi), sınır dışı reddedilir.
create temp table t_lic (name text primary key, r jsonb);
insert into t_lic select 'varsayilan', pg_temp.op('create_license', jsonb_build_object('customer', 'Varsayılan Ofis', 'machine', (select m_bound from t_ctx)));
insert into t_lic select 'yedi', pg_temp.op('create_license', '{"customer": "Yedi Cihazlı Ofis", "mobileDevices": 7}'::jsonb);
insert into t_lic select 'dizge', pg_temp.op('create_license', '{"customer": "Dizge Ofis", "mobileDevices": "5"}'::jsonb);
insert into t_lic select 'sifir', pg_temp.op('create_license', '{"customer": "Sıfır Ofis", "mobileDevices": 0}'::jsonb);
insert into t_lic select 'yuz', pg_temp.op('create_license', '{"customer": "Yüz Ofis", "mobileDevices": 100}'::jsonb);
insert into t_lic select 'null', pg_temp.op('create_license', '{"customer": "Null Ofis", "mobileDevices": null}'::jsonb);
do $$
declare
  x record;
begin
  for x in select * from t_lic loop
    assert x.r ->> 'ok' = 'true', 'lisans oluşturulamadı (' || x.name || '): ' || x.r;
  end loop;
  assert (select (r -> 'license' ->> 'mobileDevices')::int from t_lic where name = 'varsayilan') = 3, 'alan verilmeden oluşturulan lisansta mobileDevices 3 değil: ' || (select r from t_lic where name = 'varsayilan');
  assert (select (r -> 'license' ->> 'mobileDevices')::int from t_lic where name = 'yedi') = 7, 'operatörün 7 değeri yansımadı';
  assert (select (r -> 'license' ->> 'mobileDevices')::int from t_lic where name = 'dizge') = 5, 'rakam dizgesi "5" okunmadı';
  assert (select (r -> 'license' ->> 'mobileDevices')::int from t_lic where name = 'sifir') = 0, '0 yansımadı';
  assert (select (r -> 'license' ->> 'mobileDevices')::int from t_lic where name = 'yuz') = 100, '100 yansımadı';
  assert (select (r -> 'license' ->> 'mobileDevices')::int from t_lic where name = 'null') = 3, 'null değer varsayılan 3 olmadı';
  assert (select mobile_devices from lisans.licenses where id = (select r -> 'license' ->> 'id' from t_lic where name = 'yedi')) = 7, 'tabloya 7 yazılmadı';
  assert exists (select 1 from lisans.events where type = 'license.created' and (detail ->> 'mobileDevices')::int = 7), 'oluşturma hareketinde mobileDevices yok';
end $$;

create temp table t_bad (name text, v jsonb);
insert into t_bad values ('101', '101'), ('-1', '-1'), ('2.5', '2.5'), ('"abc"', '"abc"'), ('""', '""'), ('true', 'true'),
  ('"101"', '"101"'), ('"-1"', '"-1"'), ('1e3', '1e3'), ('dizi', '[3]'), ('nesne', '{"n": 3}');
do $$
declare
  x record;
  r jsonb;
  before_count int := (select count(*) from lisans.licenses);
begin
  for x in select * from t_bad loop
    r := pg_temp.op('create_license', jsonb_build_object('customer', 'Hatalı Ofis', 'mobileDevices', x.v));
    assert r ->> 'ok' = 'false' and r ->> 'code' = 'INVALID', 'sınır dışı değer kabul edildi (create ' || x.name || '): ' || r;
    assert r ->> 'error' like 'Mobil cihaz sınırı%', 'ret iletisi beklenen değil (' || x.name || '): ' || r;
  end loop;
  assert (select count(*) from lisans.licenses) = before_count, 'reddedilen oluşturma lisans satırı bıraktı';
end $$;

-- 3) Operatör: güncelleme değeri değiştirir ve hareket yazar; alan yoksa değişmez; sınır dışı reddedilir, değer korunur.
do $$
declare
  lid text := (select r -> 'license' ->> 'id' from t_lic where name = 'yedi');
  r jsonb;
  x record;
begin
  r := pg_temp.op('update_license', jsonb_build_object('id', lid, 'mobileDevices', 2));
  assert r ->> 'ok' = 'true' and (r -> 'license' ->> 'mobileDevices')::int = 2, 'güncelleme 2 yansımadı: ' || r;
  assert exists (select 1 from lisans.events where type = 'license.mobile_devices' and license_id = lid
                 and (detail ->> 'from')::int = 7 and (detail ->> 'to')::int = 2), 'license.mobile_devices hareketi (7 → 2) yazılmadı';
  r := pg_temp.op('update_license', jsonb_build_object('id', lid, 'note', 'yalnız not'));
  assert (r -> 'license' ->> 'mobileDevices')::int = 2, 'alan verilmeyen güncelleme sınırı değiştirdi: ' || r;
  r := pg_temp.op('update_license', jsonb_build_object('id', lid, 'mobileDevices', null));
  assert (r -> 'license' ->> 'mobileDevices')::int = 2, 'null güncelleme sınırı değiştirdi: ' || r;
  for x in select * from t_bad loop
    r := pg_temp.op('update_license', jsonb_build_object('id', lid, 'mobileDevices', x.v, 'note', 'olmamalı'));
    assert r ->> 'ok' = 'false' and r ->> 'code' = 'INVALID', 'sınır dışı değer kabul edildi (update ' || x.name || '): ' || r;
  end loop;
  assert (select mobile_devices from lisans.licenses where id = lid) = 2, 'reddedilen güncelleme sınırı değiştirdi';
  assert (select note from lisans.licenses where id = lid) = 'yalnız not', 'reddedilen güncelleme notu yazdı (işlem geri alınmadı)';
end $$;

-- 4) Belirteç iddiaları: lisans etkinleştirme, doğrulama, internetsiz kod, taşınmış lisansın durdurma yanıtı ve deneme.
create temp table t_claims (name text primary key, c jsonb);
insert into t_claims
select 'etkinlestirme', public.lisans_activate((select secret from t_ctx), jsonb_build_object('product', 'DestekOfis', 'machine', (select m_key from t_ctx),
  'kind', 'license', 'version', '2.4.7', 'licenseKey', (select r -> 'license' ->> 'key' from t_lic where name = 'yedi')), '10.0.0.1') -> 'claims';
insert into t_claims
select 'dogrulama', public.lisans_check((select secret from t_ctx), jsonb_build_object('product', 'DestekOfis', 'machine', (select m_key from t_ctx),
  'kind', 'license', 'version', '2.4.7', 'licenseId', (select r -> 'license' ->> 'id' from t_lic where name = 'yedi')), '10.0.0.1') -> 'claims';
insert into t_claims
select 'varsayilan', public.lisans_check((select secret from t_ctx), jsonb_build_object('product', 'DestekOfis', 'machine', (select m_bound from t_ctx),
  'kind', 'license', 'licenseId', (select r -> 'license' ->> 'id' from t_lic where name = 'varsayilan')), '10.0.0.1') -> 'claims';
insert into t_claims
select 'kod', pg_temp.op('license_code', jsonb_build_object('id', (select r -> 'license' ->> 'id' from t_lic where name = 'sifir'), 'machine', 'dddddddddddddddddddddddddddddddd')) -> 'claims';
insert into t_claims
select 'deneme', public.lisans_activate((select secret from t_ctx), jsonb_build_object('product', 'DestekOfis', 'machine', (select m_trial from t_ctx),
  'kind', 'trial', 'version', '2.4.7', 'office', jsonb_build_object('name', 'Deneme Ofisi')), '10.0.0.2') -> 'claims';
-- Taşınan lisans: "dogrulama" lisansı eski bilgisayardan ayrılır → eski bilgisayar durdurma (blocked) iddiası alır.
do $$ begin
  assert pg_temp.op('release_license', jsonb_build_object('id', (select r -> 'license' ->> 'id' from t_lic where name = 'yedi'))) ->> 'ok' = 'true', 'lisans ayrılamadı';
end $$;
insert into t_claims
select 'durdurma', public.lisans_check((select secret from t_ctx), jsonb_build_object('product', 'DestekOfis', 'machine', (select m_key from t_ctx),
  'kind', 'license', 'licenseId', (select r -> 'license' ->> 'id' from t_lic where name = 'yedi')), '10.0.0.1') -> 'claims';
do $$
declare
  x record;
begin
  for x in select * from t_claims loop
    assert x.c is not null, 'iddia gelmedi: ' || x.name;
    assert jsonb_typeof(x.c -> 'mobileDevices') = 'number', 'belirteç iddiasında mobileDevices yok (' || x.name || '): ' || x.c;
  end loop;
  assert (select (c ->> 'mobileDevices')::int from t_claims where name = 'etkinlestirme') = 2, 'etkinleştirme iddiası operatörün değerini (2) taşımıyor';
  assert (select (c ->> 'mobileDevices')::int from t_claims where name = 'dogrulama') = 2, 'doğrulama iddiası operatörün değerini (2) taşımıyor';
  assert (select (c ->> 'mobileDevices')::int from t_claims where name = 'varsayilan') = 3, 'varsayılan lisansın iddiası 3 değil';
  assert (select (c ->> 'mobileDevices')::int from t_claims where name = 'kod') = 0, 'internetsiz kod iddiası 0 değil';
  assert (select (c ->> 'mobileDevices')::int from t_claims where name = 'deneme') = 3, 'deneme iddiası 3 değil';
  assert (select c ->> 'status' from t_claims where name = 'durdurma') = 'blocked', 'durdurma iddiası blocked değil';
end $$;

-- 5) Yetki: yardımcı fonksiyon dışarıya kapalı.
do $$ begin
  assert not has_function_privilege('anon', 'lisans.mobile_devices_of(jsonb, integer)', 'execute'), 'anon mobile_devices_of çalıştırabiliyor';
  assert not has_table_privilege('anon', 'lisans.licenses', 'select'), 'anon licenses okuyabiliyor';
end $$;

select 'CLAIMS ' || name || ' ' || c::text from t_claims order by name;
select 'MOBILE_DEVICES_SQL_TAMAM' as sonuc;
