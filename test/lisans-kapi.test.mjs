// 2.4.7 M3: POST /api/lisans/v1/kapi/durum — mobil kapıcının (Cloudflare Worker) lisans durumu ucu, Vercel katmanı.
// Sözleşme program deposu docs/mobil/M3-TASARIM.md §8 madde 2 ve bulut/kapi/kapi.mjs servistenYenile. Veritabanı çağrısı (fetch)
// taklittir; canlı servise istek atılmaz. Kâhin: programın verifyToken'ı (test/fixtures/program-license-token.mjs) ve kapıcının
// kendi doğrulayıcısı (DESTEKOFIS_PROGRAM_DIR/server/lib/kapi-protokol.mjs; verilmezse o testler ATLANIR — atlanan kanıt değildir).
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import * as program from "./fixtures/program-license-token.mjs";
import { kapiIstegi, kapiKaynak, kapiOkur, programDir } from "./fixtures/kapi-program.mjs";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const KEY_ID = "destekofis-lisans-test";
process.env.SUPABASE_URL = "http://127.0.0.1:9";
process.env.SUPABASE_PUBLISHABLE_KEY = "test-anahtar";
process.env.DESTEKOFIS_API_SECRET = "x".repeat(40);
process.env.DESTEKOFIS_LICENSE_KEY = privateKey.export({ type: "pkcs8", format: "pem" });
process.env.DESTEKOFIS_LICENSE_KEY_ID = KEY_ID;
delete process.env.KAPI_LISANS_ANAHTARI;
const trusted = { [KEY_ID]: publicKey.export({ type: "spki", format: "der" }).toString("base64") };
const KAPI_ANAHTARI = "k".repeat(24) + "-dogru-anahtar-0123456789";

const { POST } = await import(new URL("../web/api/lisans/v1/kapi/durum.mjs", import.meta.url));
const URL_UC = "https://destekofis.net/api/lisans/v1/kapi/durum";

const MACHINE = "0123456789abcdef0123456789abcdef";
const LICENSE_ID = "LIS-20261029-ABCD1234";
const baseClaims = {
  schema: 1, product: "DestekOfis", type: "license-token", kind: "license", status: "active", licenseId: LICENSE_ID,
  customer: "Kapı Ofis", machine: MACHINE, issuedAt: new Date().toISOString(), startsAt: "2026-10-01T00:00:00.000Z", expiresAt: null,
  offline: false, message: "", mobileDevices: 3,
};
let dbResult = null;
const calls = [];
globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), body: JSON.parse(init.body) });
  return new Response(JSON.stringify(dbResult), { status: 200, headers: { "content-type": "application/json" } });
};

async function call(request) {
  calls.length = 0;
  const response = await POST(request);
  return { status: response.status, body: await response.json() };
}
const withKey = (key, fn) => async () => {
  if (key == null) delete process.env.KAPI_LISANS_ANAHTARI;
  else process.env.KAPI_LISANS_ANAHTARI = key;
  try {
    await fn();
  } finally {
    delete process.env.KAPI_LISANS_ANAHTARI;
  }
};

test("doğru anahtar: imzalı zarf döner; programın verifyToken'ı doğrular; veritabanına YALNIZ salt okur uç ve 3 alan gider", withKey(KAPI_ANAHTARI, async () => {
  dbResult = { ok: true, claims: { ...baseClaims, mobileDevices: 5 } };
  const { status, body } = await call(kapiIstegi(URL_UC, KAPI_ANAHTARI, LICENSE_ID, MACHINE));
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.ok, true);
  const { claims, keyId } = program.verifyToken(body.token, trusted);
  assert.equal(keyId, KEY_ID);
  assert.equal(claims.machine, MACHINE);
  assert.equal(claims.licenseId, LICENSE_ID);
  assert.equal(claims.mobileDevices, 5);
  assert.equal(calls.length, 1, "veritabanına tek istek gitmeli");
  assert.match(calls[0].url, /\/rest\/v1\/rpc\/lisans_kapi_durum$/, `yanlış veritabanı işlevi: ${calls[0].url} (lisans_check yazar; kapı ucu salt okur işlevi çağırmalı)`);
  assert.deepEqual(Object.keys(calls[0].body).sort(), ["p_body", "p_secret"], "IP ya da başka parametre gönderildi");
  assert.deepEqual(calls[0].body.p_body, { product: "DestekOfis", machine: MACHINE, licenseId: LICENSE_ID });
}));

test("yanıt /v1/check ile aynı biçimde: check'in imzaladığı zarfla alan alan aynı (issuedAt dahil, aynı iddiadan)", withKey(KAPI_ANAHTARI, async () => {
  dbResult = { ok: true, claims: baseClaims };
  const { body: kapi } = await call(kapiIstegi(URL_UC, KAPI_ANAHTARI, LICENSE_ID, MACHINE));
  const { handleLicenseRequest } = await import(new URL("../web/api/_lib/service.mjs", import.meta.url));
  const response = await handleLicenseRequest(new Request("https://destekofis.net/api/lisans/v1/check", {
    method: "POST", body: JSON.stringify({ product: "DestekOfis", version: "2.4.7", machine: MACHINE, kind: "license", licenseId: LICENSE_ID }),
  }), "lisans_check");
  const check = await response.json();
  assert.deepEqual(Object.keys(kapi).sort(), Object.keys(check).sort());
  assert.deepEqual(kapi.token, check.token, "aynı iddiadan kapı ucu ile /v1/check farklı zarf üretti");
}));

for (const [ad, header] of [
  ["başlık yok", null],
  ["yanlış anahtar", `Bearer ${KAPI_ANAHTARI.slice(0, -1)}X`],
  ["anahtarın öneki", `Bearer ${KAPI_ANAHTARI.slice(0, 20)}`],
  ["anahtar + fazlası", `Bearer ${KAPI_ANAHTARI}0`],
  ["Bearer'sız çıplak anahtar", KAPI_ANAHTARI],
  ["Basic şeması", `Basic ${KAPI_ANAHTARI}`],
  ["boş Bearer", "Bearer "],
]) {
  test(`401 — ${ad}; veritabanına istek gitmez`, withKey(KAPI_ANAHTARI, async () => {
    dbResult = { ok: true, claims: baseClaims };
    const headers = { "content-type": "application/json", ...(header == null ? {} : { authorization: header }) };
    const { status, body } = await call(new Request(URL_UC, { method: "POST", headers, body: JSON.stringify({ licenseId: LICENSE_ID, machine: MACHINE }) }));
    assert.equal(status, 401, `${ad}: ${JSON.stringify(body)}`);
    assert.equal(body.ok, false);
    assert.equal(body.code, "UNAUTHORIZED");
    assert.equal(body.token, undefined);
    assert.equal(calls.length, 0, "yetkisiz istek veritabanına ulaştı");
  }));
}

for (const [ad, value] of [["ortam değişkeni yok", null], ["ortam değişkeni boş", ""], ["ortam değişkeni kısa (31)", "a".repeat(31)]]) {
  test(`401 — ${ad} (kapalı varsayılan): gönderilen değer aynı olsa da reddedilir`, withKey(value, async () => {
    dbResult = { ok: true, claims: baseClaims };
    const { status, body } = await call(kapiIstegi(URL_UC, value || "", LICENSE_ID, MACHINE));
    assert.equal(status, 401, JSON.stringify(body));
    assert.equal(body.code, "UNAUTHORIZED");
    assert.equal(calls.length, 0);
  }));
}

for (const [ad, raw] of [
  ["boş gövde", ""],
  ["JSON değil", "{licenseId"],
  ["dizi", "[]"],
  ["makine yok", JSON.stringify({ licenseId: LICENSE_ID })],
  ["makine kısa", JSON.stringify({ licenseId: LICENSE_ID, machine: "abc" })],
  ["lisans no yok", JSON.stringify({ machine: MACHINE })],
  ["lisans no sayı", JSON.stringify({ licenseId: 12345, machine: MACHINE })],
  ["lisans no biçim dışı", JSON.stringify({ licenseId: "../x", machine: MACHINE })],
  ["çok büyük gövde (> 1 KB)", JSON.stringify({ licenseId: LICENSE_ID, machine: MACHINE, pad: "x".repeat(2000) })],
]) {
  test(`400 — ${ad}; veritabanına istek gitmez`, withKey(KAPI_ANAHTARI, async () => {
    const { status, body } = await call(new Request(URL_UC, { method: "POST", headers: { authorization: `Bearer ${KAPI_ANAHTARI}` }, body: raw }));
    assert.equal(status, 400, `${ad}: ${JSON.stringify(body)}`);
    assert.equal(body.code, "BAD_REQUEST");
    assert.equal(calls.length, 0);
  }));
}

test("veritabanı reddi (kayıt yok / başka makine) /v1/check'in ret biçimiyle geçer: 409 LICENSE_NOT_FOUND, belirteç yok", withKey(KAPI_ANAHTARI, async () => {
  dbResult = { ok: false, code: "LICENSE_NOT_FOUND", error: "Lisans bulunamadı.", status: 409 };
  const { status, body } = await call(kapiIstegi(URL_UC, KAPI_ANAHTARI, LICENSE_ID, MACHINE));
  assert.equal(status, 409);
  assert.deepEqual(body, { ok: false, code: "LICENSE_NOT_FOUND", error: "Lisans bulunamadı." });
}));

test("kurulum kodu tireli/büyük harfli gelirse normalleşir (programın kimlik kuralı)", withKey(KAPI_ANAHTARI, async () => {
  dbResult = { ok: true, claims: baseClaims };
  const { status } = await call(kapiIstegi(URL_UC, KAPI_ANAHTARI, LICENSE_ID, MACHINE.toUpperCase().match(/.{4}/g).join("-")));
  assert.equal(status, 200);
  assert.equal(calls[0].body.p_body.machine, MACHINE);
}));

const skipProgram = programDir ? false : "DESTEKOFIS_PROGRAM_DIR tanımlı değil";
test("PROGRAMIN KAPICISI yanıtı kabul eder: kapi-protokol.mjs lisansDogrula + makine eşleşmesi + lisansGecerli (etkin / süresi dolmuş / engelli)", { skip: skipProgram }, withKey(KAPI_ANAHTARI, async () => {
  const cases = [
    [{}, "gecerli"],
    [{ expiresAt: new Date(Date.now() - 86_400_000).toISOString() }, "gecersiz"],
    [{ status: "blocked", message: "Bu lisans bu bilgisayardan kaldırıldı (başka bir bilgisayara taşındı)." }, "gecersiz"],
  ];
  for (const [extra, expected] of cases) {
    dbResult = { ok: true, claims: { ...baseClaims, ...extra, mobileDevices: 4 } };
    const { body } = await call(kapiIstegi(URL_UC, KAPI_ANAHTARI, LICENSE_ID, MACHINE));
    const read = await kapiOkur(body, MACHINE, trusted);
    assert.equal(read.durum, expected, `${JSON.stringify(extra)}: kapıcı ${read.durum} (${read.neden || ""})`);
    assert.equal(read.iddia.mobileDevices, 4, "kapıcı mobileDevices'ı okuyamadı");
  }
  // Başka makinenin belirteci: kapıcı "bu ofise ait değil" der.
  dbResult = { ok: true, claims: { ...baseClaims, machine: "f".repeat(32) } };
  const { body } = await call(kapiIstegi(URL_UC, KAPI_ANAHTARI, LICENSE_ID, MACHINE));
  assert.equal((await kapiOkur(body, MACHINE, trusted)).durum, "reddedildi");
  // Yanlış anahtarla imzalanmış zarfı kapıcı kabul etmez (kâhinin dişi).
  const other = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" }).toString("base64");
  dbResult = { ok: true, claims: baseClaims };
  const again = await call(kapiIstegi(URL_UC, KAPI_ANAHTARI, LICENSE_ID, MACHINE));
  assert.equal((await kapiOkur(again.body, MACHINE, { [KEY_ID]: other })).durum, "reddedildi");
}));

test("programdaki kapı (bulut/kapi/kapi.mjs) bu ucu bu biçimle çağırıyor (yol, Bearer başlığı, gövde alanları)", { skip: skipProgram }, () => {
  assert.match(kapiKaynak, /\/v1\/kapi\/durum`/, "kapi.mjs artık /v1/kapi/durum'u çağırmıyor");
  assert.match(kapiKaynak, /authorization: `Bearer \$\{env\.KAPI_LISANS_ANAHTARI\}`/, "kapi.mjs başlık biçimi değişti");
  assert.match(kapiKaynak, /JSON\.stringify\(\{ licenseId: meta\.lisansKimligi, machine: meta\.makine \}\)/, "kapi.mjs gövde biçimi değişti");
  assert.match(kapiKaynak, /if \(!govde\?\.ok \|\| !govde\.token\)/, "kapi.mjs yanıt okuma biçimi değişti (test/fixtures/kapi-program.mjs'i güncelleyin)");
  assert.match(kapiKaynak, /iddia\.machine !== meta\.makine/, "kapi.mjs makine denetimi değişti");
});
