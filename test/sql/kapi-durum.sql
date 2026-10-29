-- 2.4.7 M3: public.lisans_kapi_durum (mobil kapıcının lisans durumu ucu) — yerel, geçici PostgreSQL'de; canlıya dokunmaz.
-- test/lisans-kapi-sql.test.mjs çalıştırır (lisans.sql koşulduktan sonra). Her ASSERT iletisi başarısız denetimin nedenini söyler.
-- Her senaryoda: (1) bütün lisans tablolarının özeti alınır, (2) kapı ucu çağrılır, (3) özet yeniden alınır ve AYNI olmalıdır
-- (salt okur), (4) aynı istek lisans_check'e verilir ve iki yanıt (issuedAt dışında) AYNI olmalıdır. Sonda imzalanacak iddiaları
-- "CLAIMS <ad> <json>" satırlarıyla basar; JS testi onları Vercel'deki signToken ile imzalayıp PROGRAMIN doğrulayıcılarıyla doğrular.
\set ON_ERROR_STOP 1
insert into lisans.settings (key, value) values ('api_secret_sha256', encode(sha256(convert_to(repeat('k', 40), 'UTF8')), 'hex'))
on conflict (key) do update set value = excluded.value;
insert into lisans.settings (key, value) values ('operator_password', extensions.crypt('operator-parola-1', extensions.gen_salt('bf', 4)))
on conflict (key) do update set value = excluded.value;

create temp table t_ctx as select repeat('k', 40) as secret;
create temp table t_sess as select public.lisans_operator((select secret from t_ctx), null, 'login', '{"password": "operator-parola-1"}'::jsonb, '') ->> 'token' as token;
create or replace function pg_temp.op(p_action text, p_args jsonb) returns jsonb language sql as $$
  select public.lisans_operator((select secret from t_ctx), (select token from t_sess), p_action, p_args, '10.0.0.9')
$$;
create or replace function pg_temp.m(p_digit text) returns text language sql immutable as $$ select repeat(p_digit, 32) $$;

-- Bütün lisans tablolarının (satır satır) özeti: herhangi bir satır eklenir, silinir ya da tek alanı değişirse özet değişir.
create or replace function pg_temp.snap() returns text language sql stable as $$
  select concat_ws(' | ',
    'installations=' || (select coalesce(md5(string_agg(t::text, ';' order by t::text)), '-') from lisans.installations t),
    'licenses=' || (select coalesce(md5(string_agg(t::text, ';' order by t::text)), '-') from lisans.licenses t),
    'license_bindings=' || (select coalesce(md5(string_agg(t::text, ';' order by t::text)), '-') from lisans.license_bindings t),
    'events=' || (select coalesce(md5(string_agg(t::text, ';' order by t::text)), '-') from lisans.events t),
    'edoc_usage=' || (select coalesce(md5(string_agg(t::text, ';' order by t::text)), '-') from lisans.edoc_usage t),
    'usage_daily=' || (select coalesce(md5(string_agg(t::text, ';' order by t::text)), '-') from lisans.usage_daily t),
    'settings=' || (select coalesce(md5(string_agg(t::text, ';' order by t::text)), '-') from lisans.settings t),
    'sessions=' || (select coalesce(md5(string_agg(t::text, ';' order by t::text)), '-') from lisans.sessions t))
$$;

-- Hazırlık (operatör ve programın kendi uçlarıyla).
create temp table t_lic (name text primary key, id text);
do $$
declare
  r jsonb;
begin
  assert (select token from t_sess) is not null, 'operatör girişi başarısız';
  -- 1: etkin lisans (bilgisayara bağlı, 5 cihaz)
  r := pg_temp.op('create_license', jsonb_build_object('customer', 'Etkin Ofis', 'machine', pg_temp.m('1'), 'mobileDevices', 5));
  assert r ->> 'ok' = 'true', 'etkin lisans: ' || r; insert into t_lic values ('etkin', r -> 'license' ->> 'id');
  -- 2: süresi dolmuş lisans
  r := pg_temp.op('create_license', jsonb_build_object('customer', 'Süresi Dolmuş Ofis', 'machine', pg_temp.m('2'), 'expiresAt', now() + interval '30 days'));
  assert r ->> 'ok' = 'true', 'süreli lisans: ' || r; insert into t_lic values ('suresi_dolmus', r -> 'license' ->> 'id');
  r := pg_temp.op('update_license', jsonb_build_object('id', (select id from t_lic where name = 'suresi_dolmus'), 'expiresAt', now() - interval '1 day'));
  assert r ->> 'ok' = 'true', 'süre geriye alınamadı: ' || r;
  -- 3: engelli lisans
  r := pg_temp.op('create_license', jsonb_build_object('customer', 'Engelli Ofis', 'machine', pg_temp.m('3')));
  assert r ->> 'ok' = 'true', 'engelli lisans: ' || r; insert into t_lic values ('engelli', r -> 'license' ->> 'id');
  r := pg_temp.op('set_license_status', jsonb_build_object('id', (select id from t_lic where name = 'engelli'), 'status', 'blocked', 'message', 'Ödeme bekleniyor.'));
  assert r ->> 'ok' = 'true', 'engellenemedi: ' || r;
  -- 4: taşınmış lisans (bilgisayardan ayrıldı)
  r := pg_temp.op('create_license', jsonb_build_object('customer', 'Taşınan Ofis', 'machine', pg_temp.m('4')));
  assert r ->> 'ok' = 'true', 'taşınacak lisans: ' || r; insert into t_lic values ('tasinmis', r -> 'license' ->> 'id');
  r := pg_temp.op('release_license', jsonb_build_object('id', (select id from t_lic where name = 'tasinmis')));
  assert r ->> 'ok' = 'true', 'ayrılamadı: ' || r;
  -- 5: etkin deneme; 6: engelli deneme; 9: süresi dolmuş deneme
  r := public.lisans_activate((select secret from t_ctx), jsonb_build_object('product', 'DestekOfis', 'machine', pg_temp.m('5'), 'kind', 'trial', 'version', '2.4.7',
    'office', jsonb_build_object('name', 'Deneme Ofisi')), '10.0.0.5');
  assert r ->> 'ok' = 'true', 'deneme: ' || r; insert into t_lic values ('deneme', r -> 'claims' ->> 'licenseId');
  r := public.lisans_activate((select secret from t_ctx), jsonb_build_object('product', 'DestekOfis', 'machine', pg_temp.m('6'), 'kind', 'trial', 'version', '2.4.7',
    'office', jsonb_build_object('name', 'Engelli Deneme')), '10.0.0.6');
  assert r ->> 'ok' = 'true', 'deneme 6: ' || r; insert into t_lic values ('deneme_engelli', r -> 'claims' ->> 'licenseId');
  r := pg_temp.op('set_trial', jsonb_build_object('machine', pg_temp.m('6'), 'status', 'blocked', 'message', 'Deneme durduruldu.'));
  assert r ->> 'ok' = 'true', 'deneme engellenemedi: ' || r;
  r := public.lisans_activate((select secret from t_ctx), jsonb_build_object('product', 'DestekOfis', 'machine', pg_temp.m('9'), 'kind', 'trial', 'version', '2.4.7',
    'office', jsonb_build_object('name', 'Biten Deneme')), '10.0.0.7');
  assert r ->> 'ok' = 'true', 'deneme 9: ' || r; insert into t_lic values ('deneme_bitti', r -> 'claims' ->> 'licenseId');
  r := pg_temp.op('set_trial', jsonb_build_object('machine', pg_temp.m('9'), 'expiresAt', now() - interval '1 hour'));
  assert r ->> 'ok' = 'true', 'deneme süresi geriye alınamadı: ' || r;
end $$;

-- Senaryolar: (ad, bilgisayar, lisans no, gövdeye eklenen alanlar, beklenen: ok, status ya da kod).
create temp table t_case (ord int primary key, name text, m text, lid text, extra jsonb, ok boolean, status text, code text);
insert into t_case values
  (1, 'etkin', pg_temp.m('1'), (select id from t_lic where name = 'etkin'), '{}', true, 'active', null),
  (2, 'suresi_dolmus', pg_temp.m('2'), (select id from t_lic where name = 'suresi_dolmus'), '{}', true, 'active', null),
  (3, 'engelli', pg_temp.m('3'), (select id from t_lic where name = 'engelli'), '{}', true, 'blocked', null),
  (4, 'tasinmis', pg_temp.m('4'), (select id from t_lic where name = 'tasinmis'), '{}', true, 'blocked', null),
  -- Kapı ucu gövdedeki fazlalığı (firma bilgisi, e-Belge kullanımı, sürüm) YAZMAMALI.
  (5, 'deneme', pg_temp.m('5'), (select id from t_lic where name = 'deneme'),
     jsonb_build_object('version', '9.9.9', 'instanceId', 'kapi-deneme', 'office', jsonb_build_object('name', 'Değişmemeli Ofis', 'phone', '0500'),
       'usage', jsonb_build_object('edoc', jsonb_build_array(jsonb_build_object('month', to_char(now() at time zone 'UTC', 'YYYY-MM'), 'env', 'live', 'efatura', 7, 'earsiv', 7, 'esmm', 7)))),
     true, 'active', null),
  (6, 'deneme_engelli', pg_temp.m('6'), (select id from t_lic where name = 'deneme_engelli'), '{}', true, 'blocked', null),
  (7, 'deneme_bitti', pg_temp.m('9'), (select id from t_lic where name = 'deneme_bitti'), '{}', true, 'active', null),
  (8, 'kayit_yok', pg_temp.m('7'), 'LIS-20261029-YOK00001', '{}', false, null, 'LICENSE_NOT_FOUND'),
  -- Başka bilgisayarın lisansı: kayıtsız bilgisayar ve kayıtlı (deneme) bilgisayar.
  (9, 'baska_makine', pg_temp.m('8'), (select id from t_lic where name = 'etkin'), '{}', false, null, 'LICENSE_NOT_FOUND'),
  (10, 'baska_makine_deneme', pg_temp.m('5'), (select id from t_lic where name = 'etkin'), '{}', false, null, 'LICENSE_NOT_FOUND'),
  (11, 'baska_makinenin_denemesi', pg_temp.m('1'), (select id from t_lic where name = 'deneme'), '{}', true, 'active', null);

create temp table t_out (ord int primary key, name text, k jsonb);
do $$
declare
  x record;
  s0 text;
  s1 text;
  kr jsonb;
  c jsonb;
  b jsonb;
begin
  for x in select * from t_case order by ord loop
    b := jsonb_build_object('product', 'DestekOfis', 'machine', x.m, 'kind', 'license', 'licenseId', x.lid) || x.extra;
    s0 := pg_temp.snap();
    kr := public.lisans_kapi_durum((select secret from t_ctx), b);
    s1 := pg_temp.snap();
    assert s0 = s1, x.name || ': kapı ucu veritabanını DEĞİŞTİRDİ' || chr(10) || 'önce:  ' || s0 || chr(10) || 'sonra: ' || s1;
    assert (kr ->> 'ok')::boolean = x.ok, x.name || ': ok beklenen ' || x.ok || ', gelen ' || kr;
    if x.ok then
      assert kr -> 'claims' ->> 'status' = x.status, x.name || ': status beklenen ' || x.status || ', gelen ' || kr;
      assert kr -> 'claims' ->> 'machine' = x.m, x.name || ': iddiadaki bilgisayar istekteki değil: ' || kr;
    else
      assert kr ->> 'code' = x.code, x.name || ': kod beklenen ' || x.code || ', gelen ' || kr;
    end if;
    -- Aynı istek /v1/check'e: sonuç aynı olmalı (issuedAt iki çağrının saatidir; aynı işlemde now() aynıdır ama yine de dışarıda tutulur).
    -- Fazlalık (firma bilgisi vb.) check'e VERİLMEZ: check onu bilerek yazar (denemenin 3. günü) ve iddiadaki unvan değişir;
    -- kapı ucu ise yazmamalı — yukarıdaki özet denetimi bunu gösterir.
    c := public.lisans_check((select secret from t_ctx), b - array['office', 'usage', 'version', 'instanceId'], '10.0.0.1');
    assert (kr #- '{claims,issuedAt}') = (c #- '{claims,issuedAt}'), x.name || ': kapı ucu ile lisans_check ayrışıyor' || chr(10) || 'kapı:  ' || kr || chr(10) || 'check: ' || c;
    insert into t_out values (x.ord, x.name, kr);
  end loop;

  -- Süresi dolmuş lisans/deneme: iddiada bitiş geçmişte (kapıcı lisansGecerli ile "gecersiz" sayar).
  assert (select (k -> 'claims' ->> 'expiresAt')::timestamptz < now() from t_out where name = 'suresi_dolmus'), 'süresi dolmuş lisansın bitişi geçmişte değil';
  assert (select (k -> 'claims' ->> 'expiresAt')::timestamptz < now() from t_out where name = 'deneme_bitti'), 'süresi dolmuş denemenin bitişi geçmişte değil';
  assert (select k -> 'claims' ->> 'message' from t_out where name = 'engelli') = 'Ödeme bekleniyor.', 'engel iletisi iddiada yok';
  assert (select (k -> 'claims' ->> 'mobileDevices')::int from t_out where name = 'etkin') = 5, 'etkin lisansın mobileDevices 5 değil';
  -- Gövdedeki firma bilgisi, sürüm ve e-Belge kullanımı yazılmadı (check çağrısı yazdı mı ayrı konu; kapıdan ÖNCEKİ hâl özetle denetlendi).
end $$;

-- Ret dalları da salt okur: yanlış API sırrı, geçersiz gövde.
do $$
declare
  s0 text := pg_temp.snap();
  r jsonb;
begin
  r := public.lisans_kapi_durum(repeat('x', 40), jsonb_build_object('product', 'DestekOfis', 'machine', pg_temp.m('1'), 'licenseId', (select id from t_lic where name = 'etkin')));
  assert r ->> 'code' = 'UNAUTHORIZED', 'yanlış API sırrı reddedilmedi: ' || r;
  r := public.lisans_kapi_durum(null, jsonb_build_object('product', 'DestekOfis', 'machine', pg_temp.m('1'), 'licenseId', (select id from t_lic where name = 'etkin')));
  assert r ->> 'code' = 'UNAUTHORIZED', 'boş API sırrı reddedilmedi: ' || r;
  r := public.lisans_kapi_durum((select secret from t_ctx), jsonb_build_object('product', 'DestekOfis', 'machine', 'kisa', 'licenseId', 'LIS-1'));
  assert r ->> 'code' = 'BAD_REQUEST', 'geçersiz bilgisayar kimliği reddedilmedi: ' || r;
  r := public.lisans_kapi_durum((select secret from t_ctx), jsonb_build_object('product', 'Baska', 'machine', pg_temp.m('1'), 'licenseId', 'LIS-1'));
  assert r ->> 'code' = 'BAD_REQUEST', 'yanlış ürün reddedilmedi: ' || r;
  r := public.lisans_kapi_durum((select secret from t_ctx), jsonb_build_object('product', 'DestekOfis', 'machine', pg_temp.m('1')));
  assert r ->> 'code' = 'BAD_REQUEST', 'lisans no olmadan reddedilmedi: ' || r;
  assert pg_temp.snap() = s0, 'ret dalları veritabanını değiştirdi';
end $$;

-- Yetki: dışarıya yalnız anon/service_role çalıştırabilir; iç işlev kimseye açık değil; public uç SECURITY DEFINER ve STABLE.
do $$ begin
  assert has_function_privilege('anon', 'public.lisans_kapi_durum(text, jsonb)', 'execute'), 'anon kapı ucunu çalıştıramıyor';
  assert not has_function_privilege('anon', 'lisans.kapi_durum_impl(text, jsonb)', 'execute'), 'anon iç işlevi doğrudan çalıştırabiliyor';
  assert not exists (select 1 from information_schema.routine_privileges where routine_schema = 'public' and routine_name = 'lisans_kapi_durum' and grantee = 'PUBLIC'),
    'kapı ucu PUBLIC rolüne açık';
  assert (select p.prosecdef and p.provolatile = 's' from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = 'lisans_kapi_durum'), 'kapı ucu SECURITY DEFINER + STABLE değil';
  assert (select p.provolatile = 's' from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'lisans' and p.proname = 'kapi_durum_impl'), 'iç işlev STABLE değil (yazmaya kapalı değil)';
end $$;

select 'CLAIMS ' || name || ' ' || (k -> 'claims')::text from t_out where (k ->> 'ok')::boolean order by ord;
select 'KAPI_DURUM_SQL_TAMAM';
