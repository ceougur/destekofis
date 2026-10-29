// 2.4.7 M2: lisans.licenses.mobile_devices — yerel, geçici PostgreSQL'de (canlı Supabase'e DOKUNMAZ). LISANS_TEST_PG yoksa ATLANIR
// (atlanan test kanıt sayılmaz). İki akış:
//   (1) boş veritabanı → lisans.sql İKİ KEZ → test/sql/mobile-devices.sql; basılan iddialar Vercel'deki signToken ile imzalanır ve
//       PROGRAMIN verifyToken'ıyla (test/fixtures/program-license-token.mjs = program deposu server/lib/license-token.mjs, bayt bayt)
//       doğrulanır: imza geçerli, mobileDevices okunuyor.
//   (2) göç: 2.4.6'daki (canlıdaki) şema (test/sql/lisans-2.4.6.sql = main dalındaki supabase/lisans.sql) + eski lisans satırları →
//       yeni lisans.sql İKİ KEZ → mevcut satırlar 3 alır, veri kaybolmaz, eski lisansın doğrulama belirteci mobileDevices 3 taşır.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { signToken } from "../web/api/_lib/token.mjs";
import { verifyToken } from "./fixtures/program-license-token.mjs";

const conn = process.env.LISANS_TEST_PG || "";
const root = fileURLToPath(new URL("..", import.meta.url));
const psql = (db, args) => spawnSync("psql", [`${conn} dbname=${db}`, "-X", "-q", "-v", "ON_ERROR_STOP=1", ...args], { cwd: root, encoding: "utf8" });
const skip = conn ? false : "LISANS_TEST_PG tanımlı değil";

function withDb(name, body) {
  const db = `${name}_${process.pid}`;
  let r = psql("postgres", ["-c", `create database ${db}`]);
  assert.equal(r.status, 0, r.stderr);
  try {
    r = psql(db, ["-c", `do $$ begin
        -- Roller küme genelidir; paralel koşan test dosyaları aynı anda oluşturabilir (yarış: zaten var → geç).
        begin create role anon nologin; exception when duplicate_object or unique_violation then null; end;
        begin create role service_role nologin; exception when duplicate_object or unique_violation then null; end;
      end $$; create schema if not exists extensions; create extension if not exists pgcrypto schema extensions;`]);
    assert.equal(r.status, 0, r.stderr);
    body(db);
  } finally {
    psql("postgres", ["-c", `drop database if exists ${db}`]);
  }
}

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const KEY_ID = "test-lisans-1";
const trusted = { [KEY_ID]: publicKey.export({ type: "spki", format: "der" }).toString("base64") };
// Vercel'in yaptığı: veritabanının iddiası → signToken → program: verifyToken.
const roundTrip = claims => verifyToken(signToken(claims, privateKey, KEY_ID), trusted).claims;

test("lisans.sql: mobile_devices — operatör, iddialar, programın doğrulamasıyla imza (yerel PostgreSQL)", { skip }, () => {
  withDb("mcl_lisans", db => {
    for (const round of [1, 2]) {
      const r = psql(db, ["-f", "supabase/lisans.sql"]);
      assert.equal(r.status, 0, `lisans.sql ${round}. koşu: ${r.stderr}`);
    }
    const r = psql(db, ["-A", "-t", "-f", "test/sql/mobile-devices.sql"]);
    assert.equal(r.status, 0, `mobile-devices.sql: ${r.stderr}`);
    assert.match(r.stdout, /MOBILE_DEVICES_SQL_TAMAM/);
    const claims = Object.fromEntries(
      r.stdout.split(/\r?\n/).filter(line => line.startsWith("CLAIMS ")).map(line => {
        const [, name, ...rest] = line.split(" ");
        return [name, JSON.parse(rest.join(" "))];
      }),
    );
    const expected = { deneme: 3, dogrulama: 2, durdurma: 2, etkinlestirme: 2, kod: 0, varsayilan: 3 };
    assert.deepEqual(Object.keys(claims).sort(), Object.keys(expected).sort(), "iddia satırları eksik");
    for (const [name, limit] of Object.entries(expected)) {
      const verified = roundTrip(claims[name]);
      assert.equal(verified.mobileDevices, limit, `${name}: programın doğruladığı belirteçte mobileDevices ${limit} değil (${JSON.stringify(verified)})`);
      assert.equal(verified.machine, claims[name].machine, `${name}: makine değişti`);
    }
    assert.equal(roundTrip(claims.durdurma).status, "blocked");
  });
});

test("göç: 2.4.6 şeması + eski lisanslar → yeni lisans.sql; mevcut satırlar 3 alır, veri kaybolmaz (yerel PostgreSQL)", { skip }, () => {
  withDb("mcl_goc", db => {
    let r = psql(db, ["-f", "test/sql/lisans-2.4.6.sql"]);
    assert.equal(r.status, 0, `2.4.6 şeması: ${r.stderr}`);
    r = psql(db, ["-c", `
      insert into lisans.settings (key, value) values ('api_secret_sha256', encode(sha256(convert_to(repeat('s', 40), 'UTF8')), 'hex'));
      insert into lisans.licenses (id, key, customer, offline, machine, activated_at, expires_at) values
        ('LIS-20260101-AAAA0001', 'DO-00000-00000-00000-0000A', 'Eski Ofis 1', false, 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', now(), null),
        ('LIS-20260101-AAAA0002', 'DO-00000-00000-00000-0000B', 'Eski Ofis 2', true, null, null, now() + interval '1 year');
      insert into lisans.license_bindings (license_id, machine) values ('LIS-20260101-AAAA0001', 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee');`]);
    assert.equal(r.status, 0, `eski veri: ${r.stderr}`);
    r = psql(db, ["-A", "-t", "-c", "select count(*) from information_schema.columns where table_schema = 'lisans' and table_name = 'licenses' and column_name = 'mobile_devices'"]);
    assert.equal(r.stdout.trim(), "0", "2.4.6 şemasında mobile_devices zaten var (eski şema dosyası yanlış)");
    for (const round of [1, 2]) {
      r = psql(db, ["-f", "supabase/lisans.sql"]);
      assert.equal(r.status, 0, `yeni lisans.sql ${round}. koşu (göç): ${r.stderr}`);
    }
    r = psql(db, ["-A", "-t", "-c", "select string_agg(id || '|' || customer || '|' || offline || '|' || mobile_devices, ';' order by id) from lisans.licenses"]);
    assert.equal(r.status, 0, `göç sonrası okuma: ${r.stderr}`);
    assert.equal(r.stdout.trim(), "LIS-20260101-AAAA0001|Eski Ofis 1|false|3;LIS-20260101-AAAA0002|Eski Ofis 2|true|3", "göçte mevcut lisanslar 3 almadı ya da veri değişti");
    r = psql(db, ["-A", "-t", "-c", `select public.lisans_check(repeat('s', 40), '{"product": "DestekOfis", "machine": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", "kind": "license", "licenseId": "LIS-20260101-AAAA0001"}'::jsonb, '')`]);
    assert.equal(r.status, 0, r.stderr);
    const result = JSON.parse(r.stdout.trim());
    assert.equal(result.ok, true, r.stdout);
    assert.equal(roundTrip(result.claims).mobileDevices, 3, "göçten sonra eski lisansın belirtecinde mobileDevices 3 değil");
  });
});
