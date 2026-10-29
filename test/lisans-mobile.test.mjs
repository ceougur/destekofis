// 2.4.7 M2: lisans belirtecindeki mobileDevices (program başına en çok eşli uzaktan cihaz) Vercel katmanında.
// Kâhin PROGRAMIN kodudur: test/fixtures/program-license-token.mjs, program deposundaki server/lib/license-token.mjs'in bayt bayt
// kopyasıdır (DESTEKOFIS_PROGRAM_DIR verilirse aynılığı denetlenir). Vercel'in imzaladığı belirteç programın verifyToken'ıyla
// doğrulanır. Veritabanı çağrısı (fetch) taklittir; canlı servise istek atılmaz.
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import * as program from "./fixtures/program-license-token.mjs";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const KEY_ID = "destekofis-lisans-test";
process.env.SUPABASE_URL = "http://127.0.0.1:9";
process.env.SUPABASE_PUBLISHABLE_KEY = "test-anahtar";
process.env.DESTEKOFIS_API_SECRET = "x".repeat(40);
process.env.DESTEKOFIS_LICENSE_KEY = privateKey.export({ type: "pkcs8", format: "pem" });
process.env.DESTEKOFIS_LICENSE_KEY_ID = KEY_ID;
const trusted = { [KEY_ID]: publicKey.export({ type: "spki", format: "der" }).toString("base64") };

const site = await import(new URL("../web/api/_lib/token.mjs", import.meta.url));
const { handleLicenseRequest } = await import(new URL("../web/api/_lib/service.mjs", import.meta.url));
const { POST: operatorPost } = await import(new URL("../web/api/operator.mjs", import.meta.url));

const MACHINE = "0123456789abcdef0123456789abcdef";
const baseClaims = {
  schema: 1, product: "DestekOfis", type: "license-token", kind: "license", status: "active", licenseId: "LIS-20261029-ABCD1234",
  customer: "Mobil Ofis", machine: MACHINE, issuedAt: "2026-10-29T00:00:00.000Z", startsAt: "2026-10-29T00:00:00.000Z", expiresAt: null,
  offline: false, message: "",
};
let dbResult = null;
globalThis.fetch = async () => new Response(JSON.stringify(dbResult), { status: 200, headers: { "content-type": "application/json" } });

const programDir = process.env.DESTEKOFIS_PROGRAM_DIR || "";
test("kâhin kopyası programın server/lib/license-token.mjs'iyle bayt bayt aynı", { skip: programDir ? false : "DESTEKOFIS_PROGRAM_DIR tanımlı değil" }, () => {
  const fixture = readFileSync(new URL("./fixtures/program-license-token.mjs", import.meta.url));
  const real = readFileSync(path.join(programDir, "server", "lib", "license-token.mjs"));
  assert.ok(fixture.equals(real), "test/fixtures/program-license-token.mjs programdaki dosyadan farklı; yeniden kopyalayın");
});

test("normalizeClaims: Vercel ve program mobileDevices için AYNI kuralı uygular (her değer)", () => {
  const values = [undefined, null, 0, 1, 3, 7, 100, 101, -1, 2.5, "3", "", true, [3], { n: 3 }, Number.NaN, Infinity, 1e3];
  for (const value of values) {
    const input = { ...baseClaims, ...(value === undefined ? {} : { mobileDevices: value }) };
    const fromSite = site.normalizeClaims(input);
    assert.deepEqual(fromSite, program.normalizeClaims(input), `mobileDevices=${JSON.stringify(value)}: Vercel ile program ayrışıyor`);
    const valid = Number.isInteger(value) && value >= 0 && value <= 100;
    assert.equal("mobileDevices" in fromSite, valid, `mobileDevices=${JSON.stringify(value)}: ${valid ? "geçerli değer belirtece girmedi" : "geçersiz değer belirtece girdi"}`);
  }
});

async function check() {
  const request = new Request("https://destekofis.net/api/lisans/v1/check", {
    method: "POST",
    body: JSON.stringify({ product: "DestekOfis", version: "2.4.7", machine: MACHINE, kind: "license", licenseId: baseClaims.licenseId }),
  });
  const response = await handleLicenseRequest(request, "lisans_check");
  return { status: response.status, body: await response.json() };
}

test("/v1/check: veritabanının mobileDevices'ı imzalı belirtece girer; program imzayı doğrular ve alanı okur", async () => {
  for (const limit of [0, 3, 7, 100]) {
    dbResult = { ok: true, claims: { ...baseClaims, mobileDevices: limit } };
    const { status, body } = await check();
    assert.equal(status, 200);
    const { claims, keyId } = program.verifyToken(body.token, trusted);
    assert.equal(keyId, KEY_ID);
    assert.equal(claims.mobileDevices, limit, `belirteçte mobileDevices ${limit} değil`);
    assert.equal(JSON.parse(Buffer.from(body.token.payload, "base64").toString("utf8")).mobileDevices, limit, "imzalanan ham iddiada mobileDevices yok");
  }
});

test("/v1/check: eski veritabanı alanı vermezse belirteç alansız kalır (program 3 sayar); sınır dışı değer belirtece girmez", async () => {
  for (const extra of [{}, { mobileDevices: 101 }, { mobileDevices: -1 }, { mobileDevices: "5" }]) {
    dbResult = { ok: true, claims: { ...baseClaims, ...extra } };
    const { body } = await check();
    const { claims } = program.verifyToken(body.token, trusted);
    assert.equal("mobileDevices" in claims, false, `${JSON.stringify(extra)}: alan belirtece girdi`);
  }
});

test("Operatör Merkezi internetsiz kodu mobileDevices taşır (program kodu çözer ve doğrular)", async () => {
  dbResult = { ok: true, claims: { ...baseClaims, offline: true, mobileDevices: 5 }, license: { id: baseClaims.licenseId } };
  const request = new Request("https://destekofis.net/api/operator", {
    method: "POST",
    headers: { "x-destekofis": "operator", cookie: `do_op=${"a".repeat(64)}` },
    body: JSON.stringify({ action: "license_code", args: { id: baseClaims.licenseId } }),
  });
  const response = await operatorPost(request);
  assert.equal(response.status, 200);
  const body = await response.json();
  const { claims } = program.verifyToken(program.decodeCode(body.code), trusted);
  assert.equal(claims.mobileDevices, 5, "internetsiz kodda mobileDevices 5 değil");
  assert.equal(claims.offline, true);
});
