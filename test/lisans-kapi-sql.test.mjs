// 2.4.7 M3: public.lisans_kapi_durum (mobil kapıcının lisans durumu ucu) — yerel, geçici PostgreSQL'de (canlı Supabase'e DOKUNMAZ).
// LISANS_TEST_PG yoksa ATLANIR (atlanan test kanıt sayılmaz). Akış: boş veritabanı → lisans.sql İKİ KEZ → test/sql/kapi-durum.sql
// (her senaryoda tablo özeti önce/sonra AYNI + lisans_check ile AYNI sonuç) → basılan iddialar Vercel'deki signToken ile imzalanır;
// PROGRAMIN verifyToken'ı (test/fixtures/program-license-token.mjs) ve kapıcının doğrulayıcısı (kapi-protokol.mjs) ile okunur.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { signToken } from "../web/api/_lib/token.mjs";
import { verifyToken } from "./fixtures/program-license-token.mjs";
import { kapiOkur, programDir } from "./fixtures/kapi-program.mjs";

const conn = process.env.LISANS_TEST_PG || "";
const root = fileURLToPath(new URL("..", import.meta.url));
const psql = (db, args) => spawnSync("psql", [`${conn} dbname=${db}`, "-X", "-q", "-v", "ON_ERROR_STOP=1", ...args], { cwd: root, encoding: "utf8" });
const skip = conn ? false : "LISANS_TEST_PG tanımlı değil";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const KEY_ID = "test-lisans-kapi";
const trusted = { [KEY_ID]: publicKey.export({ type: "spki", format: "der" }).toString("base64") };

function runScenario() {
  const db = `kapi_lisans_${process.pid}`;
  let r = psql("postgres", ["-c", `create database ${db}`]);
  assert.equal(r.status, 0, r.stderr);
  try {
    r = psql(db, ["-c", `do $$ begin
        begin create role anon nologin; exception when duplicate_object or unique_violation then null; end;
        begin create role service_role nologin; exception when duplicate_object or unique_violation then null; end;
      end $$; create schema if not exists extensions; create extension if not exists pgcrypto schema extensions;`]);
    assert.equal(r.status, 0, r.stderr);
    for (const round of [1, 2]) {
      r = psql(db, ["-f", "supabase/lisans.sql"]);
      assert.equal(r.status, 0, `lisans.sql ${round}. koşu: ${r.stderr}`);
    }
    r = psql(db, ["-A", "-t", "-f", "test/sql/kapi-durum.sql"]);
    assert.equal(r.status, 0, `kapi-durum.sql: ${r.stderr}`);
    assert.match(r.stdout, /KAPI_DURUM_SQL_TAMAM/);
    return Object.fromEntries(
      r.stdout.split(/\r?\n/).filter(line => line.startsWith("CLAIMS ")).map(line => {
        const [, name, ...rest] = line.split(" ");
        return [name, JSON.parse(rest.join(" "))];
      }),
    );
  } finally {
    psql("postgres", ["-c", `drop database if exists ${db}`]);
  }
}

// Beklenen (kapıcının gözüyle): etkin → gecerli; süresi dolmuş / engelli / taşınmış → gecersiz.
const EXPECTED = {
  etkin: { status: "active", kapi: "gecerli" },
  suresi_dolmus: { status: "active", kapi: "gecersiz" },
  engelli: { status: "blocked", kapi: "gecersiz" },
  tasinmis: { status: "blocked", kapi: "gecersiz" },
  deneme: { status: "active", kapi: "gecerli" },
  deneme_engelli: { status: "blocked", kapi: "gecersiz" },
  deneme_bitti: { status: "active", kapi: "gecersiz" },
  baska_makinenin_denemesi: { status: "active", kapi: "gecerli" },
};

let claims = null;
test("lisans_kapi_durum: salt okur + lisans_check ile aynı karar; iddialar programın verifyToken'ıyla imzalı doğrulanır (yerel PostgreSQL)", { skip }, () => {
  claims = runScenario();
  assert.deepEqual(Object.keys(claims).sort(), Object.keys(EXPECTED).sort(), "belirteç dönen senaryolar beklenenden farklı");
  for (const [name, exp] of Object.entries(EXPECTED)) {
    const verified = verifyToken(signToken(claims[name], privateKey, KEY_ID), trusted).claims;
    assert.equal(verified.status, exp.status, `${name}: status`);
    assert.equal(verified.machine, claims[name].machine, `${name}: makine`);
  }
});

test("lisans_kapi_durum iddiaları PROGRAMIN KAPICISINDAN geçer (kapi-protokol.mjs lisansDogrula + lisansGecerli)", { skip: skip || (programDir ? false : "DESTEKOFIS_PROGRAM_DIR tanımlı değil") }, async () => {
  assert.ok(claims, "önceki test iddia üretmedi");
  for (const [name, exp] of Object.entries(EXPECTED)) {
    const token = signToken(claims[name], privateKey, KEY_ID);
    const read = await kapiOkur({ ok: true, token }, claims[name].machine, trusted);
    assert.equal(read.durum, exp.kapi, `${name}: kapıcı ${read.durum} (${read.neden || ""}) — beklenen ${exp.kapi}`);
  }
});
