// 2.4.7 C1: supabase/lisans.sql yerel, geçici bir PostgreSQL veritabanında (canlı Supabase'e DOKUNMAZ).
// Gerekli: psql ve LISANS_TEST_PG (libpq bağlantı dizgesi, ör. "host=/var/tmp/pg port=5432 user=postgres"). Yoksa test
// ATLANIR (atlanan test kanıt sayılmaz). Akış: geçici veritabanı → Supabase'in rol/eklenti ortamının benzeri (anon,
// service_role, extensions.pgcrypto) → lisans.sql İKİ KEZ (yeniden koşulabilirlik) → test/sql/edoc-usage.sql → veritabanı silinir.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const conn = process.env.LISANS_TEST_PG || "";
const root = fileURLToPath(new URL("..", import.meta.url));
const psql = (db, args) => spawnSync("psql", [`${conn} dbname=${db}`, "-X", "-q", "-v", "ON_ERROR_STOP=1", ...args], { cwd: root, encoding: "utf8" });

test("lisans.sql: edoc_usage + lisans_check + operatör (yerel PostgreSQL)", { skip: conn ? false : "LISANS_TEST_PG tanımlı değil" }, () => {
  const db = `e6_lisans_${process.pid}`;
  let r = psql("postgres", ["-c", `create database ${db}`]);
  assert.equal(r.status, 0, r.stderr);
  try {
    r = psql(db, ["-c", `do $$ begin
        -- Roller küme genelidir; paralel koşan test dosyaları aynı anda oluşturabilir (yarış: zaten var → geç).
        begin create role anon nologin; exception when duplicate_object or unique_violation then null; end;
        begin create role service_role nologin; exception when duplicate_object or unique_violation then null; end;
      end $$; create schema if not exists extensions; create extension if not exists pgcrypto schema extensions;`]);
    assert.equal(r.status, 0, r.stderr);
    for (const round of [1, 2]) {
      r = psql(db, ["-f", "supabase/lisans.sql"]);
      assert.equal(r.status, 0, `lisans.sql ${round}. koşu: ${r.stderr}`);
    }
    r = psql(db, ["-f", "test/sql/edoc-usage.sql"]);
    assert.equal(r.status, 0, `edoc-usage.sql: ${r.stderr}`);
    assert.match(r.stdout, /EDOC_USAGE_SQL_TAMAM/);
  } finally {
    psql("postgres", ["-c", `drop database if exists ${db}`]);
  }
});
