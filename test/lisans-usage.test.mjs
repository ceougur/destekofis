// 2.4.7 C1: /v1/check gövdesindeki e-Belge kullanım özeti (usage.edoc) Vercel katmanında.
// Değişmezler: (1) geçersiz / eksik / aşırı büyük / negatif / yanlış ay biçimli özet lisans yanıtını DEĞİŞTİRMEZ (aynı durum
// kodu, aynı gövde) ve veritabanına gitmez; (2) geçerli satırlar veritabanına yalnız izin verilen alanlarla gider.
// Veritabanı çağrısı (fetch) taklittir; canlı servise istek atılmaz. Koşu: node --test test/
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";

const { privateKey } = generateKeyPairSync("ed25519");
process.env.SUPABASE_URL = "http://127.0.0.1:9";
process.env.SUPABASE_PUBLISHABLE_KEY = "test-anahtar";
process.env.DESTEKOFIS_API_SECRET = "x".repeat(40);
process.env.DESTEKOFIS_LICENSE_KEY = privateKey.export({ type: "pkcs8", format: "pem" });

const { handleLicenseRequest } = await import(new URL("../web/api/_lib/service.mjs", import.meta.url));

const MACHINE = "0123456789abcdef0123456789abcdef";
const claims = {
  schema: 1, product: "DestekOfis", type: "license-token", kind: "trial", status: "active", licenseId: "TR-20261029-ABCD",
  machine: MACHINE, issuedAt: "2026-10-29T00:00:00.000Z", startsAt: "2026-10-29T00:00:00.000Z", expiresAt: "2026-11-28T00:00:00.000Z",
};
const calls = [];
globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), args: JSON.parse(init.body) });
  return new Response(JSON.stringify({ ok: true, claims }), { status: 200, headers: { "content-type": "application/json" } });
};

const baseBody = { product: "DestekOfis", version: "2.4.7", machine: MACHINE, instanceId: "i-1", kind: "trial", licenseId: claims.licenseId };
async function check(extra) {
  calls.length = 0;
  const request = new Request("https://destekofis.net/api/lisans/v1/check", { method: "POST", body: JSON.stringify({ ...baseBody, ...extra }) });
  const response = await handleLicenseRequest(request, "lisans_check");
  const body = await response.json();
  // İmza aynı iddialar için aynıdır (Ed25519 belirlenimci); karşılaştırma için gövde metni yeter.
  return { status: response.status, body: JSON.stringify(body), sent: calls[0]?.args?.p_body };
}
const row = (month, env, efatura = 1, earsiv = 2, esmm = 3) => ({ month, env, efatura, earsiv, esmm });

test("özetsiz istek: veritabanına usage gitmez (taban)", async () => {
  const base = await check({});
  assert.equal(base.status, 200);
  assert.equal(JSON.parse(base.body).ok, true);
  assert.equal("usage" in base.sent, false);
});

test("geçersiz usage girdileri lisans yanıtını değiştirmez ve veritabanına gitmez", async () => {
  const base = await check({});
  const invalid = {
    "null": null,
    "dizi": [row("2026-10", "live")],
    "metin": "edoc",
    "sayı": 5,
    "edoc yok": {},
    "edoc nesne": { edoc: { month: "2026-10" } },
    "edoc boş": { edoc: [] },
    "13 satır (aşırı büyük)": { edoc: Array.from({ length: 13 }, (_, i) => row(`2026-${String((i % 12) + 1).padStart(2, "0")}`, "live")) },
    "1000 satır": { edoc: Array.from({ length: 1000 }, () => row("2026-10", "live")) },
    "negatif": { edoc: [row("2026-10", "live", -1)] },
    "kesirli": { edoc: [row("2026-10", "live", 1.5)] },
    "sayı metin": { edoc: [row("2026-10", "live", "4")] },
    "üst sınır aşımı": { edoc: [row("2026-10", "live", 1_000_001)] },
    "NaN yerine null": { edoc: [row("2026-10", "live", null)] },
    "eksik tür": { edoc: [{ month: "2026-10", env: "live", efatura: 1, earsiv: 2 }] },
    "ay 13": { edoc: [row("2026-13", "live")] },
    "ay 00": { edoc: [row("2026-00", "live")] },
    "ay biçimi 2026/10": { edoc: [row("2026/10", "live")] },
    "ay biçimi 2026-1": { edoc: [row("2026-1", "live")] },
    "ay sayı": { edoc: [{ ...row("x", "live"), month: 202610 }] },
    "ortam prod": { edoc: [row("2026-10", "prod")] },
    "ortam büyük harf": { edoc: [row("2026-10", "LIVE")] },
    "satır dizi": { edoc: [[1, 2, 3]] },
  };
  for (const [name, usage] of Object.entries(invalid)) {
    const result = await check({ usage });
    assert.equal(result.status, base.status, name);
    assert.equal(result.body, base.body, name);
    assert.equal("usage" in result.sent, false, `${name}: usage veritabanına gitmemeli`);
  }
});

test("geçerli usage yalnız izin verilen alanlarla veritabanına gider; yanıt aynı", async () => {
  const base = await check({});
  const usage = {
    edoc: [
      { ...row("2026-10", "live", 5, 7, 0), etten: "GİTMEMELİ", alici: "X", tutar: 100 },
      row("2026-10", "test", 1, 0, 0),
      row("2026-09", "live", 0, 0, 0),
      row("2026-08", "live", 2, 2, 2),
      row("2026-13", "live"), // geçersiz satır atılır, diğerleri kalır
      row("2026-10", "live", 99, 99, 99), // aynı (ay, ortam) ikinci kez: ilki geçer
    ],
    vkn: "1234567890",
  };
  const result = await check({ usage });
  assert.equal(result.status, base.status);
  assert.equal(result.body, base.body);
  assert.deepEqual(result.sent.usage, {
    edoc: [row("2026-10", "live", 5, 7, 0), row("2026-10", "test", 1, 0, 0), row("2026-09", "live", 0, 0, 0), row("2026-08", "live", 2, 2, 2)],
  });
});

test("gövde sınırları: lisans alanları 16 KB'ı aşarsa (önceki gibi) ve toplam gövde 256 KB'ı aşarsa BAD_REQUEST", async () => {
  const bigRest = await check({ office: { name: "x".repeat(17_000) } });
  assert.equal(bigRest.status, 400);
  const huge = await check({ usage: { edoc: Array.from({ length: 5000 }, () => row("2026-10", "live")) } });
  assert.equal(huge.status, 400, "256 KB üstü: program özetsiz yineler (BİLİNEN SINIR)");
  assert.equal(JSON.parse(huge.body).code, "BAD_REQUEST");
});

test("12 satır sınırda kabul edilir", async () => {
  const edoc = [];
  for (const env of ["live", "test"]) for (let m = 5; m <= 10; m++) edoc.push(row(`2026-${String(m).padStart(2, "0")}`, env));
  const result = await check({ usage: { edoc } });
  assert.equal(result.sent.usage.edoc.length, 12);
});

test("activate isteğinde usage veritabanına gitmez", async () => {
  calls.length = 0;
  const request = new Request("https://destekofis.net/api/lisans/v1/activate", {
    method: "POST",
    body: JSON.stringify({ ...baseBody, office: { name: "Ofis" }, usage: { edoc: [row("2026-10", "live")] } }),
  });
  const response = await handleLicenseRequest(request, "lisans_activate");
  assert.equal(response.status, 200);
  assert.equal("usage" in calls[0].args.p_body, false);
});
