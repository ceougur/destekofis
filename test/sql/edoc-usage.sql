-- 2.4.7 C1: lisans.edoc_usage ve lisans_check'in usage işleyişi (yerel, geçici PostgreSQL'de; canlıya dokunmaz).
-- test/lisans-sql.test.mjs çalıştırır: kurulum + lisans.sql İKİ KEZ (yeniden koşulabilirlik) + bu dosya. Her ASSERT iletisi
-- başarısız denetimin nedenini söyler.
\set ON_ERROR_STOP 1
insert into lisans.settings (key, value) values ('api_secret_sha256', encode(sha256(convert_to(repeat('s', 40), 'UTF8')), 'hex'))
on conflict (key) do update set value = excluded.value;

create temp table t_ctx as select repeat('s', 40) as secret,
  '0123456789abcdef0123456789abcdef'::text as m,
  to_char(date_trunc('month', now() at time zone 'UTC'), 'YYYY-MM') as cur,
  to_char(date_trunc('month', now() at time zone 'UTC') - interval '1 month', 'YYYY-MM') as prev1,
  to_char(date_trunc('month', now() at time zone 'UTC') - interval '2 month', 'YYYY-MM') as prev2,
  to_char(date_trunc('month', now() at time zone 'UTC') - interval '4 month', 'YYYY-MM') as old4,
  to_char(date_trunc('month', now() at time zone 'UTC') + interval '2 month', 'YYYY-MM') as fut2;

-- Deneme başlat (kurulum kaydı oluşur), lisans numarasını al.
create temp table t_trial as
select public.lisans_activate((select secret from t_ctx),
  jsonb_build_object('product', 'DestekOfis', 'machine', (select m from t_ctx), 'kind', 'trial', 'version', '2.4.7',
                     'office', jsonb_build_object('name', 'Deneme Ofisi')), '10.0.0.1') as r;
do $$ begin assert (select r ->> 'ok' from t_trial) = 'true', 'deneme başlatılamadı: ' || (select r::text from t_trial); end $$;

create or replace function pg_temp.body(p_usage jsonb) returns jsonb language sql as $$
  select jsonb_build_object('product', 'DestekOfis', 'machine', (select m from t_ctx), 'kind', 'trial', 'version', '2.4.7',
                            'licenseId', (select r -> 'claims' ->> 'licenseId' from t_trial))
         || case when p_usage is null then '{}'::jsonb else jsonb_build_object('usage', p_usage) end
$$;
create or replace function pg_temp.chk(p_usage jsonb) returns jsonb language sql as $$
  select public.lisans_check((select secret from t_ctx), pg_temp.body(p_usage), '10.0.0.1') #- '{claims,issuedAt}'
$$;
create or replace function pg_temp.urow(p_month text, p_env text, a jsonb, b jsonb, c jsonb) returns jsonb language sql as $$
  select jsonb_build_object('month', p_month, 'env', p_env, 'efatura', a, 'earsiv', b, 'esmm', c)
$$;

-- 1) Taban: özetsiz doğrulama.
create temp table t_base as select pg_temp.chk(null) as r;
do $$ begin
  assert (select r ->> 'ok' from t_base) = 'true', 'taban doğrulama başarısız: ' || (select r::text from t_base);
  assert (select count(*) from lisans.edoc_usage) = 0, 'özetsiz doğrulamada edoc_usage satırı yazıldı';
end $$;

-- 2) Geçersiz özetler: lisans yanıtı tabanla AYNI, hiçbir satır yazılmaz.
create temp table t_invalid (name text, u jsonb);
insert into t_invalid
select 'null json', 'null'::jsonb union all
select 'dizi', jsonb_build_array(pg_temp.urow((select cur from t_ctx), 'live', '1', '1', '1')) union all
select 'metin', '"edoc"'::jsonb union all
select 'edoc yok', '{}'::jsonb union all
select 'edoc nesne', '{"edoc": {"month": "x"}}'::jsonb union all
select 'edoc boş', '{"edoc": []}'::jsonb union all
select '13 satır (aşırı büyük)', jsonb_build_object('edoc', (select jsonb_agg(pg_temp.urow((select cur from t_ctx), 'live', '1', '1', '1')) from generate_series(1, 13))) union all
select 'negatif', jsonb_build_object('edoc', jsonb_build_array(pg_temp.urow((select cur from t_ctx), 'live', '-1', '0', '0'))) union all
select 'kesirli', jsonb_build_object('edoc', jsonb_build_array(pg_temp.urow((select cur from t_ctx), 'live', '1.5', '0', '0'))) union all
select 'üst sınır aşımı', jsonb_build_object('edoc', jsonb_build_array(pg_temp.urow((select cur from t_ctx), 'live', '1000001', '0', '0'))) union all
select 'çok büyük sayı', jsonb_build_object('edoc', jsonb_build_array(pg_temp.urow((select cur from t_ctx), 'live', '1e30', '0', '0'))) union all
select 'sayı metin', jsonb_build_object('edoc', jsonb_build_array(pg_temp.urow((select cur from t_ctx), 'live', '"4"', '0', '0'))) union all
select 'eksik tür', jsonb_build_object('edoc', jsonb_build_array(jsonb_build_object('month', (select cur from t_ctx), 'env', 'live', 'efatura', 1, 'earsiv', 1))) union all
select 'ay 13', jsonb_build_object('edoc', jsonb_build_array(pg_temp.urow('2026-13', 'live', '1', '1', '1'))) union all
select 'ay biçimi', jsonb_build_object('edoc', jsonb_build_array(pg_temp.urow(replace((select cur from t_ctx), '-', '/'), 'live', '1', '1', '1'))) union all
select 'ay sayı', jsonb_build_object('edoc', jsonb_build_array(jsonb_build_object('month', 202610, 'env', 'live', 'efatura', 1, 'earsiv', 1, 'esmm', 1))) union all
select 'eski ay (4 ay önce)', jsonb_build_object('edoc', jsonb_build_array(pg_temp.urow((select old4 from t_ctx), 'live', '1', '1', '1'))) union all
select 'ileri ay (2 ay sonra)', jsonb_build_object('edoc', jsonb_build_array(pg_temp.urow((select fut2 from t_ctx), 'live', '1', '1', '1'))) union all
select 'ortam prod', jsonb_build_object('edoc', jsonb_build_array(pg_temp.urow((select cur from t_ctx), 'prod', '1', '1', '1'))) union all
select 'satır dizi', '{"edoc": [[1, 2, 3]]}'::jsonb;

do $$
declare
  x record;
  got jsonb;
  base jsonb := (select r from t_base);
begin
  for x in select * from t_invalid loop
    got := pg_temp.chk(x.u);
    assert got = base, format('geçersiz özet (%s) lisans yanıtını değiştirdi: %s', x.name, got);
    assert (select count(*) from lisans.edoc_usage) = 0, format('geçersiz özet (%s) edoc_usage satırı yazdı', x.name);
  end loop;
end $$;

-- 3) Geçerli özet: doğru satırlar yazılır, yanıt aynı; fazla alanlar (ETTN vb.) saklanmaz; aynı (ay, ortam) ikinci satırı yok sayılır.
do $$
declare
  c record;
  got jsonb;
begin
  select * into c from t_ctx;
  got := pg_temp.chk(jsonb_build_object('edoc', jsonb_build_array(
    pg_temp.urow(c.cur, 'live', '5', '7', '0') || '{"ettn": "GİTMEMELİ"}'::jsonb,
    pg_temp.urow(c.cur, 'test', '1', '0', '0'),
    pg_temp.urow(c.prev1, 'live', '0', '0', '0'),
    pg_temp.urow(c.prev2, 'live', '2', '2', '2'),
    pg_temp.urow('2026-13', 'live', '9', '9', '9'),
    pg_temp.urow(c.cur, 'live', '99', '99', '99'))));
  assert got = (select r from t_base), 'geçerli özet lisans yanıtını değiştirdi: ' || got;
  assert (select count(*) from lisans.edoc_usage) = 4, 'geçerli özette 4 satır beklendi, yazılan: ' || (select count(*) from lisans.edoc_usage);
  assert (select (efatura, earsiv, esmm) = (5, 7, 0) from lisans.edoc_usage where month = c.cur and env = 'live'), 'bu ay canlı satırı yanlış (ilk satır alınmalı)';
  assert (select (efatura, earsiv, esmm) = (1, 0, 0) from lisans.edoc_usage where month = c.cur and env = 'test'), 'bu ay test satırı yanlış';
  assert (select (efatura, earsiv, esmm) = (2, 2, 2) from lisans.edoc_usage where month = c.prev2 and env = 'live'), 'iki ay önceki satır yanlış';
  assert (select bool_and(license_id = (select r -> 'claims' ->> 'licenseId' from t_trial) and version = '2.4.7') from lisans.edoc_usage), 'lisans/sürüm yazılmadı';
end $$;

-- 4) Aynı ay ikinci gönderim: ÜZERİNE YAZILIR (toplanmaz); gelmeyen eski ay satırı korunur.
do $$
declare
  c record;
begin
  select * into c from t_ctx;
  perform pg_temp.chk(jsonb_build_object('edoc', jsonb_build_array(pg_temp.urow(c.cur, 'live', '6', '7', '1'), pg_temp.urow(c.prev1, 'live', '3', '0', '0'))));
  assert (select (efatura, earsiv, esmm) = (6, 7, 1) from lisans.edoc_usage where month = c.cur and env = 'live'), 'ikinci gönderim üzerine yazmadı: '
    || (select row(efatura, earsiv, esmm)::text from lisans.edoc_usage where month = c.cur and env = 'live');
  assert (select (efatura, earsiv, esmm) = (3, 0, 0) from lisans.edoc_usage where month = c.prev1 and env = 'live'), 'geç kesinleşme düzeltilmedi';
  assert (select count(*) from lisans.edoc_usage) = 4, 'satır sayısı değişmemeliydi';
end $$;

-- 5) Reddedilen doğrulama (bilinmeyen kurulum / lisans) özet yazmaz; yanıtı da değişmez.
do $$
declare
  b jsonb := jsonb_build_object('product', 'DestekOfis', 'machine', 'ffffffffffffffffffffffffffffffff', 'kind', 'trial', 'licenseId', 'DEN-YOK');
  r0 jsonb;
  r1 jsonb;
begin
  r0 := public.lisans_check((select secret from t_ctx), b, '');
  r1 := public.lisans_check((select secret from t_ctx), b || jsonb_build_object('usage', jsonb_build_object('edoc', jsonb_build_array(pg_temp.urow((select cur from t_ctx), 'live', '1', '1', '1')))), '');
  assert r0 ->> 'code' = 'LICENSE_NOT_FOUND' and r0 = r1, 'reddedilen doğrulamanın yanıtı değişti: ' || r1;
  assert not exists (select 1 from lisans.edoc_usage where machine = 'ffffffffffffffffffffffffffffffff'), 'reddedilen doğrulama özet yazdı';
  -- Kurulum kaydı OLAN bilgisayar, tanınmayan lisans numarasıyla: doğrulama reddedilir, özet yine yazılmaz.
  b := jsonb_build_object('product', 'DestekOfis', 'machine', (select m from t_ctx), 'kind', 'trial', 'licenseId', 'DEN-YOK');
  r0 := public.lisans_check((select secret from t_ctx), b, '');
  r1 := public.lisans_check((select secret from t_ctx), b || jsonb_build_object('usage', jsonb_build_object('edoc', jsonb_build_array(pg_temp.urow((select cur from t_ctx), 'live', '40', '40', '40')))), '');
  assert r0 ->> 'code' = 'LICENSE_NOT_FOUND' and r0 = r1, 'kayıtlı kurulumda reddedilen doğrulamanın yanıtı değişti: ' || r1;
  assert (select efatura from lisans.edoc_usage where machine = (select m from t_ctx) and month = (select cur from t_ctx) and env = 'live') = 6,
    'reddedilen doğrulama (kayıtlı kurulum) özeti yazdı';
end $$;

-- 6) Kayıt hatası lisans yanıtını bozmaz: tabloyu geçici olarak yazılamaz yap (tetikleyici hata atar) → yanıt aynı.
create or replace function pg_temp.boom() returns trigger language plpgsql as $$ begin raise exception 'zorla hata'; end $$;
create trigger t_boom before insert or update on lisans.edoc_usage for each row execute function pg_temp.boom();
do $$
declare
  got jsonb;
begin
  got := pg_temp.chk(jsonb_build_object('edoc', jsonb_build_array(pg_temp.urow((select cur from t_ctx), 'live', '50', '50', '50'))));
  assert got = (select r from t_base), 'kayıt hatası lisans yanıtını bozdu: ' || got;
  assert (select efatura from lisans.edoc_usage where month = (select cur from t_ctx) and env = 'live') = 6, 'hata sonrası satır değişmemeliydi';
end $$;
drop trigger t_boom on lisans.edoc_usage;

-- 7) Operatör: edoc_usage işlemi (oturumla) ofis × ay satırlarını, ortam süzgecini (varsayılan canlı) ve ay seçimini verir.
insert into lisans.settings (key, value) values ('operator_password', extensions.crypt('operator-parola-1', extensions.gen_salt('bf', 4)))
on conflict (key) do update set value = excluded.value;
create temp table t_sess as select public.lisans_operator((select secret from t_ctx), null, 'login', '{"password": "operator-parola-1"}'::jsonb, '') ->> 'token' as token;
do $$
declare
  s text := (select token from t_sess);
  sec text := (select secret from t_ctx);
  live jsonb;
  test jsonb;
  one jsonb;
  anon jsonb;
begin
  assert s is not null, 'operatör girişi başarısız';
  live := public.lisans_operator(sec, s, 'edoc_usage', '{}'::jsonb, '');
  assert live ->> 'ok' = 'true' and live ->> 'env' = 'live', 'varsayılan ortam canlı olmalı: ' || live;
  assert jsonb_array_length(live -> 'items') = 3, 'canlıda 3 satır beklendi: ' || live;
  assert (live -> 'items' -> 0 ->> 'officeName') = 'Deneme Ofisi', 'ofis adı gelmedi';
  assert (live -> 'items' -> 0 ->> 'month') = (select cur from t_ctx) and (live -> 'items' -> 0 ->> 'total')::int = 14, 'ilk satır bu ay ve toplam 14 olmalı: ' || (live -> 'items' -> 0);
  assert jsonb_array_length(live -> 'months') = 3 and live -> 'months' ->> 0 = (select cur from t_ctx), 'ay listesi yanlış: ' || (live -> 'months');
  test := public.lisans_operator(sec, s, 'edoc_usage', '{"env": "test"}'::jsonb, '');
  assert test ->> 'env' = 'test' and jsonb_array_length(test -> 'items') = 1, 'test süzgeci yanlış: ' || test;
  one := public.lisans_operator(sec, s, 'edoc_usage', jsonb_build_object('month', (select prev1 from t_ctx)), '');
  assert jsonb_array_length(one -> 'items') = 1 and (one -> 'items' -> 0 ->> 'efatura')::int = 3, 'ay seçimi yanlış: ' || one;
  anon := public.lisans_operator(sec, null, 'edoc_usage', '{}'::jsonb, '');
  assert anon ->> 'code' = 'SESSION', 'oturumsuz istek reddedilmeli: ' || anon;
end $$;

-- 8) Yetki: tablo doğrudan erişime kapalı (RLS açık, anon'a hak yok).
do $$ begin
  assert (select relrowsecurity from pg_class where oid = 'lisans.edoc_usage'::regclass), 'edoc_usage RLS kapalı';
  assert not has_table_privilege('anon', 'lisans.edoc_usage', 'select'), 'anon edoc_usage okuyabiliyor';
  assert not has_function_privilege('anon', 'lisans.record_edoc_usage(text, jsonb)', 'execute'), 'anon record_edoc_usage çalıştırabiliyor';
end $$;

select 'EDOC_USAGE_SQL_TAMAM' as sonuc;
