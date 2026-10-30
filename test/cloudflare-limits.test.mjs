// 2.4.8 C1: Operatör Merkezi › Özet › Altyapı limitleri › "Cloudflare (Mobil)" kartının sunucu tarafı.
// Değişmezler: (1) ortam değişkeni yoksa "not_configured", Cloudflare'e istek YOK; (2) okunamayan bölüm "Okunamadı" der, sayı
// (0 dahil) taşımaz (ders 4); (3) %70 sarı, %90 kırmızı; (4) belirteç yanıta ve günlüğe ÇIKMAZ; (5) oturum doğrulanmadan
// Cloudflare'e gidilmez; (6) önbellek. Cloudflare ve veritabanı çağrıları (fetch) taklittir; gerçek servislere istek atılmaz.
// Koşu: node --test test/
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { beforeEach, test } from "node:test";

const { privateKey } = generateKeyPairSync("ed25519");
process.env.SUPABASE_URL = "http://127.0.0.1:9";
process.env.SUPABASE_PUBLISHABLE_KEY = "test-anahtar";
process.env.DESTEKOFIS_API_SECRET = "x".repeat(40);
process.env.DESTEKOFIS_LICENSE_KEY = privateKey.export({ type: "pkcs8", format: "pem" });

const TOKEN = "cfTESTbelirtec_GIZLI_0123456789abcdefghij";
const ACCOUNT = "0123456789abcdef0123456789abcdef";

const { POST: operatorPost } = await import(new URL("../web/api/operator.mjs", import.meta.url));
const cf = await import(new URL("../web/api/_lib/cloudflare.mjs", import.meta.url));

// --- taklit ---------------------------------------------------------------------------------------------------------
let dbResult;
let scene;
const calls = [];
const ok = body => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const fail = (status, message) => new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message }] }), { status });

const ZONE_ID = "fedcba9876543210fedcba9876543210";
const NEW_ZONE = { id: ZONE_ID, name: "destekofis.net", created_on: "2026-10-01T12:00:00.000Z", plan: { legacy_id: "free", name: "Free Website" } };
function sceneOf({ workers = 1_000, storage = [], ops = [], tunnels = [], workersFail, r2Fail, tunnelsFail, zone = NEW_ZONE, dnsTotal = 12, zoneFail, dnsFail } = {}) {
  return { workers, storage, ops, tunnels, workersFail, r2Fail, tunnelsFail, zone, dnsTotal, zoneFail, dnsFail };
}

globalThis.fetch = async (url, init = {}) => {
  const href = String(url);
  const headers = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
  calls.push({ href, auth: headers.authorization, body: init.body ? JSON.parse(init.body) : null });
  if (href.startsWith("http://127.0.0.1:9/rest/v1/rpc/")) return ok(dbResult);
  assert.ok(href.startsWith("https://api.cloudflare.com/client/v4/"), `beklenmeyen adres ${href}`);
  if (href.endsWith("/graphql")) {
    const query = JSON.parse(init.body).query;
    if (query.includes("workersInvocationsAdaptive")) {
      if (scene.workersFail) return scene.workersFail();
      return ok({ data: { viewer: { accounts: [{ workersInvocationsAdaptive: [
        { sum: { requests: Math.floor(scene.workers / 2) }, dimensions: { scriptName: "destekofis-kapi" } },
        { sum: { requests: scene.workers - Math.floor(scene.workers / 2) }, dimensions: { scriptName: "baska" } },
      ] }] } }, errors: null });
    }
    if (scene.r2Fail) return scene.r2Fail();
    return ok({ data: { viewer: { accounts: [{ r2StorageAdaptiveGroups: scene.storage, r2OperationsAdaptiveGroups: scene.ops }] } }, errors: null });
  }
  if (href.includes("/zones?")) {
    if (scene.zoneFail) return scene.zoneFail();
    const name = new URL(href).searchParams.get("name");
    return ok({ success: true, errors: [], result: scene.zone && scene.zone.name === name ? [scene.zone] : [], result_info: { total_count: scene.zone ? 1 : 0 } });
  }
  if (href.includes(`/zones/${ZONE_ID}/dns_records`)) {
    if (scene.dnsFail) return scene.dnsFail();
    return ok({ success: true, errors: [], result: [{ id: "r1", type: "CNAME" }], result_info: { page: 1, per_page: 1, count: 1, total_count: scene.dnsTotal } });
  }
  if (href.includes("/cfd_tunnel")) {
    if (scene.tunnelsFail) return scene.tunnelsFail();
    const page = Number(new URL(href).searchParams.get("page"));
    const per = Number(new URL(href).searchParams.get("per_page"));
    const result = scene.tunnels.slice((page - 1) * per, page * per);
    return ok({ success: true, errors: [], result, result_info: { page, per_page: per, total_pages: Math.max(1, Math.ceil(scene.tunnels.length / per)), total_count: scene.tunnels.length } });
  }
  throw new Error(`beklenmeyen Cloudflare adresi ${href}`);
};

const INFRA = { ok: true, level: "ok", vercel: { level: "ok" }, supabase: { level: "ok" } };
async function infra(args = {}) {
  const request = new Request("https://destekofis.net/api/operator", {
    method: "POST",
    headers: { "x-destekofis": "operator", cookie: `do_op=${"a".repeat(64)}` },
    body: JSON.stringify({ action: "infra", args }),
  });
  const response = await operatorPost(request);
  const text = await response.text();
  return { status: response.status, text, body: JSON.parse(text) };
}
const cfCalls = () => calls.filter(call => call.href.startsWith("https://api.cloudflare.com/"));
const tunnel = (status, i) => ({ id: `t-${i}`, name: `destekofis-ofis${i}`, status });
const GB = 1024 ** 3;

beforeEach(() => {
  process.env.CF_ANALYTICS_TOKEN = TOKEN;
  process.env.CF_ACCOUNT_ID = ACCOUNT;
  delete process.env.CF_ZONE_NAME;
  cf.resetCloudflareCache();
  calls.length = 0;
  dbResult = INFRA;
  scene = sceneOf();
});

// --- testler --------------------------------------------------------------------------------------------------------
test("bağlantı yok: değişkenler tanımsızsa not_configured ve Cloudflare'e istek gitmez", async () => {
  for (const [name, missing] of [["ikisi", ["CF_ACCOUNT_ID", "CF_ANALYTICS_TOKEN"]], ["belirteç", ["CF_ANALYTICS_TOKEN"]], ["hesap", ["CF_ACCOUNT_ID"]]]) {
    cf.resetCloudflareCache();
    calls.length = 0;
    process.env.CF_ANALYTICS_TOKEN = missing.includes("CF_ANALYTICS_TOKEN") ? "" : TOKEN;
    process.env.CF_ACCOUNT_ID = missing.includes("CF_ACCOUNT_ID") ? "  " : ACCOUNT;
    const { status, body } = await infra();
    assert.equal(status, 200, name);
    assert.equal(body.vercel.level, "ok", `${name}: Vercel/Supabase verisi korunmalı`);
    assert.equal(body.cloudflare.status, "not_configured", name);
    assert.deepEqual(body.cloudflare.missing, missing, name);
    assert.equal("workers" in body.cloudflare, false, `${name}: sayı taşımamalı`);
    assert.equal(cfCalls().length, 0, `${name}: Cloudflare'e istek gitti`);
  }
});

test("normal: Worker, R2 (kova başına son ölçüm, A/B sınıfı) ve tünel sayıları doğru; seviye Normal", async () => {
  scene = sceneOf({
    workers: 1_234,
    storage: [
      { max: { payloadSize: 3 * GB, metadataSize: 1_000, objectCount: 50 }, dimensions: { bucketName: "destekofis-ozet", datetime: "2026-10-30T10:00:00Z" } },
      { max: { payloadSize: 9 * GB, metadataSize: 0, objectCount: 99 }, dimensions: { bucketName: "destekofis-ozet", datetime: "2026-10-29T10:00:00Z" } },
      { max: { payloadSize: 1 * GB, metadataSize: 0, objectCount: 5 }, dimensions: { bucketName: "baska", datetime: "2026-10-30T09:00:00Z" } },
    ],
    ops: [
      { sum: { requests: 1_000 }, dimensions: { actionType: "PutObject" } },
      { sum: { requests: 500 }, dimensions: { actionType: "ListObjects" } },
      { sum: { requests: 70_000 }, dimensions: { actionType: "GetObject" } },
      { sum: { requests: 5_000 }, dimensions: { actionType: "HeadObject" } },
      { sum: { requests: 9_999_999 }, dimensions: { actionType: "DeleteObject" } }, // ücretsiz: sayılmaz
    ],
    tunnels: [tunnel("healthy", 1), tunnel("degraded", 2), tunnel("down", 3), tunnel("inactive", 4)],
  });
  const { body } = await infra();
  const c = body.cloudflare;
  assert.equal(c.status, "connected");
  assert.equal(c.level, "ok");
  assert.equal(c.workers.requests, 1_234);
  assert.equal(c.workers.limit, 100_000);
  assert.equal(c.r2.storageBytes, 4 * GB + 1_000, "her kovanın EN SON ölçümü toplanmalı");
  assert.equal(c.r2.storageLimitBytes, 10_000_000_000, "R2 kotası ondalık 10 GB (10^9 bayt; GiB değil)");
  assert.equal(c.r2.buckets, 2);
  assert.equal(c.r2.objects, 55);
  assert.equal(c.r2.classA, 1_500);
  assert.equal(c.r2.classB, 75_000);
  assert.equal(c.r2.classALimit, 1_000_000);
  assert.equal(c.r2.classBLimit, 10_000_000);
  assert.equal(c.tunnels.total, 4);
  assert.equal(c.tunnels.connected, 2);
  assert.equal(c.tunnels.limit, 1_000);
  assert.equal(c.limitsVerified, true, "kota rakamları resmî belgeden doğrulandı");
  // Sorgu bugünün UTC başından ve ayın başından okur; hesap kimliği değişkenle gider.
  const gql = cfCalls().filter(call => call.href.endsWith("/graphql"));
  assert.equal(gql.length, 2);
  for (const call of gql) assert.equal(call.body.variables.account, ACCOUNT);
  const w = gql.find(call => call.body.query.includes("workersInvocationsAdaptive")).body.variables;
  assert.match(w.start, /T00:00:00\.000Z$/);
  const r = gql.find(call => call.body.query.includes("r2OperationsAdaptiveGroups")).body.variables;
  assert.match(r.monthStart, /-01T00:00:00\.000Z$/);
});

test("%70 sarı, %90 kırmızı (her ölçü kendi başına kartı yükseltir); sınırda eşik dahil", async () => {
  const cases = [
    [{ workers: 69_999 }, "ok"],
    [{ workers: 70_000 }, "warn"],
    [{ workers: 90_000 }, "bad"],
    [{ storage: [{ max: { payloadSize: 7_000_000_000, metadataSize: 0, objectCount: 1 }, dimensions: { bucketName: "b", datetime: "2026-10-30T00:00:00Z" } }] }, "warn"],
    // 6,6 GiB = 7,09·10^9 bayt: ondalık kotada %70 (sarı), GiB kotasında %66 (Normal) olurdu.
    [{ storage: [{ max: { payloadSize: 6.6 * GB, metadataSize: 0, objectCount: 1 }, dimensions: { bucketName: "b", datetime: "2026-10-30T00:00:00Z" } }] }, "warn"],
    [{ storage: [{ max: { payloadSize: 6_999_999_999, metadataSize: 0, objectCount: 1 }, dimensions: { bucketName: "b", datetime: "2026-10-30T00:00:00Z" } }] }, "ok"],
    [{ ops: [{ sum: { requests: 900_000 }, dimensions: { actionType: "PutObject" } }] }, "bad"],
    [{ ops: [{ sum: { requests: 7_500_000 }, dimensions: { actionType: "GetObject" } }] }, "warn"],
    [{ tunnels: Array.from({ length: 950 }, (_, i) => tunnel("healthy", i)) }, "bad"],
  ];
  for (const [extra, level] of cases) {
    cf.resetCloudflareCache();
    scene = sceneOf(extra);
    const { body } = await infra();
    assert.equal(body.cloudflare.status, "connected", JSON.stringify(extra).slice(0, 80));
    assert.equal(body.cloudflare.level, level, JSON.stringify(extra).slice(0, 80));
  }
});

test("API hatası: okunamayan bölüm 'Okunamadı' der ve sayı taşımaz; biri okunursa kısmi, hepsi düşerse hata", async () => {
  scene = sceneOf({ workersFail: () => fail(403, "Authentication error"), tunnels: [tunnel("healthy", 1)] });
  let { body } = await infra();
  assert.equal(body.cloudflare.status, "partial");
  assert.match(body.cloudflare.workers.error, /^Okunamadı: Cloudflare HTTP 403: Authentication error/);
  assert.equal("requests" in body.cloudflare.workers, false, "okunamayan bölümde sayı (0) olmamalı");
  assert.equal(body.cloudflare.r2.classA, 0, "okunan bölüm etkilenmemeli");
  assert.equal(body.cloudflare.tunnels.total, 1);

  cf.resetCloudflareCache();
  scene = sceneOf({
    workersFail: () => ok({ data: null, errors: [{ message: "not authorized for that account" }] }), // 200 + GraphQL hatası
    r2Fail: () => new Response("<html>bad gateway</html>", { status: 502 }),
    tunnelsFail: () => { throw new TypeError("fetch failed"); },
    zoneFail: () => fail(403, "Unauthorized to access requested resource"),
  });
  ({ body } = await infra());
  assert.equal(body.cloudflare.status, "error");
  assert.match(body.cloudflare.workers.error, /^Okunamadı: Cloudflare: not authorized/);
  assert.match(body.cloudflare.r2.error, /^Okunamadı: Cloudflare HTTP 502/);
  assert.match(body.cloudflare.tunnels.error, /^Okunamadı: Cloudflare'e ulaşılamadı/);
  for (const part of ["workers", "r2", "tunnels", "dns"]) assert.deepEqual(Object.keys(body.cloudflare[part]), ["error"], part);

  cf.resetCloudflareCache();
  scene = sceneOf({ workersFail: () => ok({ data: { viewer: { accounts: [] } } }) }); // yanlış hesap kimliği
  ({ body } = await infra());
  assert.match(body.cloudflare.workers.error, /hesabı bulunamadı/);

  cf.resetCloudflareCache();
  scene = sceneOf({ workersFail: () => ok({ data: { viewer: { accounts: [{ workersInvocationsAdaptive: [{ sum: { requests: "çok" } }] }] } } }) });
  ({ body } = await infra());
  assert.match(body.cloudflare.workers.error, /geçersiz sayı/);

  cf.resetCloudflareCache();
  process.env.CF_ACCOUNT_ID = "hesap-adi";
  ({ body } = await infra());
  assert.equal(body.cloudflare.status, "error");
  assert.match(body.cloudflare.error, /^Okunamadı: CF_ACCOUNT_ID/);
});

test("tünel: sayfalı liste baştan sona sayılır (150 tünel), bağlı = healthy + degraded; silinenler sorguda dışarıda", async () => {
  scene = sceneOf({ tunnels: Array.from({ length: 150 }, (_, i) => tunnel(i % 3 === 0 ? "down" : i % 3 === 1 ? "healthy" : "degraded", i)) });
  const { body } = await infra();
  assert.equal(body.cloudflare.tunnels.total, 150);
  assert.equal(body.cloudflare.tunnels.connected, 100);
  assert.equal(body.cloudflare.tunnels.pct, 15);
  const pages = cfCalls().filter(call => call.href.includes("/cfd_tunnel"));
  assert.equal(pages.length, 2);
  for (const call of pages) {
    assert.ok(call.href.startsWith(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/cfd_tunnel?`));
    assert.match(call.href, /is_deleted=false/);
  }
});

test("belirteç yanıta ve günlüğe çıkmaz (Cloudflare hata iletisinde belirteci yansıtsa bile); yalnız Cloudflare'e başlıkta gider", async () => {
  const logs = [];
  const original = { error: console.error, log: console.log, warn: console.warn };
  for (const name of Object.keys(original)) console[name] = (...args) => logs.push(args.map(String).join(" "));
  try {
    scene = sceneOf({
      workersFail: () => fail(400, `Invalid token ${TOKEN}`),
      r2Fail: () => fail(401, `Authorization: Bearer ${TOKEN}`),
      tunnelsFail: () => { throw new Error(`boom ${TOKEN}`); },
    });
    const bad = await infra();
    cf.resetCloudflareCache();
    scene = sceneOf();
    const good = await infra();
    for (const text of [bad.text, good.text, ...logs]) {
      assert.equal(text.includes(TOKEN), false, `belirteç sızdı: ${text.slice(0, 120)}`);
      assert.equal(text.includes(TOKEN.slice(0, 20)), false);
    }
    assert.ok(logs.length >= 1, "hata günlüğe (belirteçsiz) yazılmalı");
  } finally {
    Object.assign(console, original);
  }
  for (const call of calls) {
    if (call.href.startsWith("https://api.cloudflare.com/")) assert.equal(call.auth, `Bearer ${TOKEN}`);
    else assert.equal(JSON.stringify(call).includes(TOKEN), false, "belirteç veritabanına gitti");
  }
});

test("oturum doğrulanmadan Cloudflare'e gidilmez; refresh veritabanına gitmez", async () => {
  dbResult = { ok: false, code: "SESSION", error: "Oturum yok", status: 401 };
  const denied = await infra();
  assert.equal(denied.status, 401);
  assert.equal("cloudflare" in denied.body, false);
  assert.equal(cfCalls().length, 0, "oturumsuz istek Cloudflare'e gitti");
  dbResult = INFRA;
  calls.length = 0;
  await infra({ refresh: true });
  const rpcCall = calls.find(call => call.href.includes("/rpc/lisans_operator"));
  assert.equal(rpcCall.body.p_action, "infra");
  assert.equal("refresh" in rpcCall.body.p_args, false);
});

test("önbellek: 10 dk içinde ikinci açılış Cloudflare'e gitmez; Yenile dakikada birden sık dış istek açmaz; hata kısa tutulur", async () => {
  await infra();
  const first = cfCalls().length;
  assert.equal(first, 5, "5 istek: Worker, R2, tünel, alan, DNS kayıtları");
  const again = await infra();
  assert.equal(cfCalls().length, first);
  assert.equal(again.body.cloudflare.cached, true);
  await infra({ refresh: true });
  assert.equal(cfCalls().length, first, "Yenile 60 sn içinde yeniden okumamalı");

  // Önbellek yaşlandırılır: Date.now ileri alınır.
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 61_000;
    await infra({ refresh: true });
    assert.equal(cfCalls().length, first * 2, "60 sn sonra Yenile okumalı");
    Date.now = () => realNow() + 61_000 + 9 * 60_000;
    await infra();
    assert.equal(cfCalls().length, first * 2, "10 dk dolmadan okumamalı");
    Date.now = () => realNow() + 61_000 + 10 * 60_000 + 1;
    await infra();
    assert.equal(cfCalls().length, first * 3, "10 dk sonra okumalı");

    // Hata sonucu 1 dk önbelleklenir.
    cf.resetCloudflareCache();
    scene = sceneOf({ workersFail: () => fail(500, "x") });
    const base = cfCalls().length;
    await infra();
    Date.now = () => realNow() + 61_000 + 10 * 60_000 + 30_000;
    await infra();
    assert.equal(cfCalls().length, base + 5, "kısmi sonuç 1 dk içinde tekrar okunmamalı");
    Date.now = () => realNow() + 61_000 + 10 * 60_000 + 62_000;
    await infra();
    assert.equal(cfCalls().length, base + 10, "kısmi sonuç 1 dk sonra yeniden okunmalı");
  } finally {
    Date.now = realNow;
  }
});

test("eşzamanlı iki açılış tek okuma yapar", async () => {
  await Promise.all([infra(), infra()]);
  assert.equal(cfCalls().length, 5);
});

test("DNS kayıtları: kota alanın planı ve açılış tarihinden (Free: 01.09.2024 öncesi 1.000, sonrası 200); %70 / %90; kota varsayılmaz", async () => {
  const quota = cf.dnsQuotaOf;
  assert.equal(quota({ created_on: "2024-08-31T23:59:59Z", plan: { legacy_id: "free" } }), 1_000);
  assert.equal(quota({ created_on: "2019-03-10T08:00:00Z", plan: { name: "Free Website" } }), 1_000);
  assert.equal(quota({ created_on: "2024-09-01T00:00:00Z", plan: { legacy_id: "free" } }), 200);
  assert.equal(quota({ created_on: "2026-10-01T12:00:00Z", plan: { name: "Free Website" } }), 200);
  assert.equal(quota({ plan: { legacy_id: "free" } }), null, "açılış tarihi yoksa 200 varsayılmamalı");
  assert.equal(quota({ created_on: "çok eski", plan: { legacy_id: "free" } }), null);
  assert.equal(quota({ created_on: "2026-10-01T12:00:00Z", plan: { legacy_id: "pro", name: "Pro Website" } }), null, "Free dışı plan: kota bilinmiyor");

  const cases = [
    [{ dnsTotal: 12 }, 200, "ok"],
    [{ dnsTotal: 139 }, 200, "ok"],
    [{ dnsTotal: 140 }, 200, "warn"],
    [{ dnsTotal: 170 }, 200, "warn"],
    [{ dnsTotal: 181 }, 200, "bad"],
    [{ dnsTotal: 181, zone: { ...NEW_ZONE, created_on: "2024-08-15T00:00:00Z" } }, 1_000, "ok"],
    [{ dnsTotal: 950, zone: { ...NEW_ZONE, created_on: "2024-08-15T00:00:00Z" } }, 1_000, "bad"],
  ];
  for (const [extra, limit, level] of cases) {
    cf.resetCloudflareCache();
    scene = sceneOf(extra);
    const { body } = await infra();
    const name = JSON.stringify(extra);
    assert.equal(body.cloudflare.status, "connected", name);
    assert.equal(body.cloudflare.dns.zone, "destekofis.net", name);
    assert.equal(body.cloudflare.dns.total, extra.dnsTotal, name);
    assert.equal(body.cloudflare.dns.limit, limit, name);
    assert.equal(body.cloudflare.level, level, name);
  }
  // Kayıt sayısı tek sayfa isteğinin total_count'undan; alan doğru kimlikle.
  const dnsCall = cfCalls().find(call => call.href.includes("/dns_records"));
  assert.ok(dnsCall.href.startsWith(`https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records?`));

  // Okunamadı: kota ya da sayı belirlenemezse sayı (0 ya da 200) taşınmaz.
  const unreadable = {
    "alan yok": { zone: null },
    "alan izni yok": { zoneFail: () => fail(403, "Unauthorized to access requested resource") },
    "açılış tarihi yok": { zone: { ...NEW_ZONE, created_on: undefined } },
    "ücretli plan": { zone: { ...NEW_ZONE, plan: { legacy_id: "pro", name: "Pro Website" } } },
    "DNS izni yok": { dnsFail: () => fail(403, "Authentication error") },
    "sayı yok": { dnsFail: () => ok({ success: true, errors: [], result: [], result_info: {} }) },
  };
  for (const [name, extra] of Object.entries(unreadable)) {
    cf.resetCloudflareCache();
    scene = sceneOf(extra);
    const { body } = await infra();
    assert.equal(body.cloudflare.status, "partial", name);
    assert.match(body.cloudflare.dns.error, /^Okunamadı: /, name);
    assert.deepEqual(Object.keys(body.cloudflare.dns), ["error"], `${name}: sayı/kota taşımamalı`);
  }

  // CF_ZONE_NAME başka alanı seçer; geçersiz ad okunmaz.
  cf.resetCloudflareCache();
  process.env.CF_ZONE_NAME = "ornek.com.tr";
  scene = sceneOf({ zone: { ...NEW_ZONE, name: "ornek.com.tr" }, dnsTotal: 3 });
  let { body } = await infra();
  assert.equal(body.cloudflare.dns.zone, "ornek.com.tr");
  assert.equal(body.cloudflare.dns.total, 3);
  cf.resetCloudflareCache();
  process.env.CF_ZONE_NAME = "ornek.com/../x";
  ({ body } = await infra());
  assert.equal(body.cloudflare.status, "error");
  assert.match(body.cloudflare.error, /CF_ZONE_NAME/);
});
