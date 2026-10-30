// Operatör Merkezi › Özet › Altyapı limitleri › "Cloudflare (Mobil)" kartı (2.4.8 C1).
//
// Mobil kullanımın Cloudflare tarafı (program deposu bulut/kapi: Worker destekofis-kapi, R2 destekofis-ozet, ofis başına bir
// tünel destekofis-<ofis>) ücretsiz plan kotalarına oranlanır. Veri YALNIZ sunucu tarafında okunur; belirteç yanıta, hata
// iletisine ve günlüğe girmez.
//
// Ortam değişkenleri (Vercel → destek-ofis → Settings → Environment Variables):
//   CF_ACCOUNT_ID       Cloudflare hesap kimliği (32 onaltılık karakter; düz)
//   CF_ANALYTICS_TOKEN  YALNIZ OKUMA yetkili API belirteci (Sensitive): Account Analytics Read, Workers R2 Storage Read,
//                       Cloudflare Tunnel Read. Kapıcının CF_API_TOKEN'ı (yazma yetkili) BURADA KULLANILMAZ.
// İkisi de yoksa kart "Bağlantı Kurulmadı" der; okuma başarısızsa ilgili satır "Okunamadı" der (0 / boş gösterilmez).
//
// Kaynaklar: GraphQL Analytics (workersInvocationsAdaptive; r2StorageAdaptiveGroups, r2OperationsAdaptiveGroups) ve
// REST GET /accounts/{id}/cfd_tunnel. Sonuç 10 dakika önbelleklenir (Yenile en çok dakikada bir dış isteğe yol açar; hata 1 dk).
//
// KOTALAR (Cloudflare ücretsiz planı; resmî belgeden doğrulandı 30.10.2026: workers/platform/limits, r2/pricing,
// cloudflare-one/account-limits → CF_LIMITS_VERIFIED=true):
//   Workers 100.000 istek/gün (UTC 00:00'da sıfırlanır), R2 10 GB-ay Standard depolama (10^9 bayt), A sınıfı 1.000.000 / ay, B sınıfı 10.000.000 / ay,
//   hesap başına 1.000 tünel.

export const CF_LIMITS = Object.freeze({
  workerRequestsPerDay: 100_000,
  r2StorageBytes: 10 * 1000 ** 3, // "10 GB-month": Cloudflare faturası ondalık GB (10^9) kullanır
  r2ClassAPerMonth: 1_000_000,
  r2ClassBPerMonth: 10_000_000,
  tunnelsPerAccount: 1_000,
});
export const CF_LIMITS_VERIFIED = true;

// R2 işlem sınıfları (Cloudflare R2 fiyatlandırma sayfasındaki adlar). Silme ve iptal işlemleri ücretsizdir, sayılmaz.
const CLASS_A = new Set([
  "ListBuckets", "PutBucket", "ListObjects", "PutObject", "CopyObject", "CompleteMultipartUpload", "CreateMultipartUpload",
  "LifecycleStorageTierTransition", "ListMultipartUploads", "UploadPart", "UploadPartCopy", "ListParts", "PutBucketEncryption",
  "PutBucketCors", "PutBucketLifecycleConfiguration",
]);
const CLASS_B = new Set([
  "HeadBucket", "HeadObject", "GetObject", "UsageSummary", "GetBucketEncryption", "GetBucketLocation", "GetBucketCors",
  "GetBucketLifecycleConfiguration",
]);

const API = "https://api.cloudflare.com/client/v4";
const CACHE_MS = 10 * 60_000;
const ERROR_CACHE_MS = 60_000;
const REFRESH_MIN_MS = 60_000;
const TIMEOUT_MS = 8_000;

const env = name => String(process.env[name] || "").trim();
// Aşağı yuvarlanır: eşik (%70 / %90) gerçekten aşılmadan sarı/kırmızı görünmez.
const pct = (used, limit) => (limit > 0 ? Math.floor((used / limit) * 1000) / 10 : 0);
export const levelOf = value => (value >= 90 ? "bad" : value >= 70 ? "warn" : "ok");
const RANK = { ok: 0, warn: 1, bad: 2 };

class CfError extends Error {}

// Hata iletisi kullanıcıya gider: belirteç (ve olası "Bearer …" parçası) her durumda silinir, uzunluk sınırlanır.
function clean(message, token) {
  let text = String(message || "bilinmeyen hata");
  if (token) text = text.split(token).join("***");
  return text.replace(/Bearer\s+\S+/gi, "Bearer ***").slice(0, 160);
}

async function call(url, token, init = {}) {
  let response;
  try {
    response = await fetch(url, {
      ...init,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw new CfError(`Cloudflare'e ulaşılamadı (${error?.name || "ağ"})`);
  }
  let data = null;
  try {
    data = await response.json();
  } catch {
    // aşağıda ele alınır
  }
  const apiError = data?.errors?.[0]?.message;
  if (!response.ok) throw new CfError(`Cloudflare HTTP ${response.status}${apiError ? `: ${apiError}` : ""}`);
  if (!data || typeof data !== "object") throw new CfError("Cloudflare yanıtı okunamadı");
  if (Array.isArray(data.errors) && data.errors.length) throw new CfError(`Cloudflare: ${apiError || "hata"}`);
  return data;
}

async function graphql(token, query, variables) {
  const data = await call(`${API}/graphql`, token, { method: "POST", body: JSON.stringify({ query, variables }) });
  const account = data?.data?.viewer?.accounts?.[0];
  if (!account) throw new CfError("Cloudflare hesabı bulunamadı (hesap kimliğini ya da belirteç iznini denetleyin)");
  return account;
}

const WORKERS_QUERY = `query ($account: String!, $start: Time!, $end: Time!) {
  viewer { accounts(filter: { accountTag: $account }) {
    workersInvocationsAdaptive(limit: 10000, filter: { datetime_geq: $start, datetime_lt: $end }) { sum { requests } dimensions { scriptName } }
  } }
}`;

const R2_QUERY = `query ($account: String!, $monthStart: Time!, $storageStart: Time!, $end: Time!) {
  viewer { accounts(filter: { accountTag: $account }) {
    r2StorageAdaptiveGroups(limit: 10000, filter: { datetime_geq: $storageStart, datetime_leq: $end }, orderBy: [datetime_DESC]) {
      max { payloadSize metadataSize objectCount } dimensions { bucketName datetime }
    }
    r2OperationsAdaptiveGroups(limit: 10000, filter: { datetime_geq: $monthStart, datetime_leq: $end }) { sum { requests } dimensions { actionType } }
  } }
}`;

const num = value => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new CfError("Cloudflare yanıtında geçersiz sayı");
  return n;
};

async function readWorkers(token, accountId, now) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const end = new Date(start.getTime() + 86_400_000);
  const account = await graphql(token, WORKERS_QUERY, { account: accountId, start: start.toISOString(), end: end.toISOString() });
  const rows = account.workersInvocationsAdaptive;
  if (!Array.isArray(rows)) throw new CfError("Worker istek sayısı yanıtta yok");
  const requests = rows.reduce((sum, row) => sum + num(row?.sum?.requests ?? 0), 0);
  const limit = CF_LIMITS.workerRequestsPerDay;
  return { requests, limit, pct: pct(requests, limit), since: start.toISOString(), resetsAt: end.toISOString() };
}

async function readR2(token, accountId, now) {
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const storageStart = new Date(now.getTime() - 2 * 86_400_000);
  const account = await graphql(token, R2_QUERY, {
    account: accountId, monthStart: monthStart.toISOString(), storageStart: storageStart.toISOString(), end: now.toISOString(),
  });
  const storageRows = account.r2StorageAdaptiveGroups;
  const opRows = account.r2OperationsAdaptiveGroups;
  if (!Array.isArray(storageRows) || !Array.isArray(opRows)) throw new CfError("R2 kullanımı yanıtta yok");
  // Depolama anlık değerdir: her kovanın EN SON ölçümü alınır (yanıt yeniden eskiye sıralı; yine de tarih karşılaştırılır).
  const latest = new Map();
  for (const row of storageRows) {
    const bucket = String(row?.dimensions?.bucketName || "");
    const at = String(row?.dimensions?.datetime || "");
    const prev = latest.get(bucket);
    if (!prev || at > prev.at) latest.set(bucket, { at, bytes: num(row?.max?.payloadSize ?? 0) + num(row?.max?.metadataSize ?? 0), objects: num(row?.max?.objectCount ?? 0) });
  }
  let storageBytes = 0;
  let objects = 0;
  for (const item of latest.values()) {
    storageBytes += item.bytes;
    objects += item.objects;
  }
  let classA = 0;
  let classB = 0;
  for (const row of opRows) {
    const action = String(row?.dimensions?.actionType || "");
    const requests = num(row?.sum?.requests ?? 0);
    if (CLASS_A.has(action)) classA += requests;
    else if (CLASS_B.has(action)) classB += requests;
  }
  return {
    storageBytes, storageLimitBytes: CF_LIMITS.r2StorageBytes, storagePct: pct(storageBytes, CF_LIMITS.r2StorageBytes),
    buckets: latest.size, objects,
    classA, classALimit: CF_LIMITS.r2ClassAPerMonth, classAPct: pct(classA, CF_LIMITS.r2ClassAPerMonth),
    classB, classBLimit: CF_LIMITS.r2ClassBPerMonth, classBPct: pct(classB, CF_LIMITS.r2ClassBPerMonth),
    monthStart: monthStart.toISOString(),
  };
}

async function readTunnels(token, accountId) {
  let total = 0;
  let connected = 0;
  for (let page = 1; page <= 20; page++) {
    const data = await call(`${API}/accounts/${accountId}/cfd_tunnel?is_deleted=false&per_page=100&page=${page}`, token);
    if (!Array.isArray(data.result)) throw new CfError("Tünel listesi yanıtta yok");
    total += data.result.length;
    connected += data.result.filter(tunnel => tunnel?.status === "healthy" || tunnel?.status === "degraded").length;
    const pages = Number(data.result_info?.total_pages);
    if (data.result.length < 100 || !(pages > page)) break;
  }
  const limit = CF_LIMITS.tunnelsPerAccount;
  return { total, connected, limit, pct: pct(total, limit) };
}

let cache = null; // { at, data }
let inflight = null;

export function resetCloudflareCache() {
  cache = null;
  inflight = null;
}

async function settle(promise, token) {
  try {
    return await promise;
  } catch (error) {
    return { error: `Okunamadı: ${clean(error?.message, token)}` };
  }
}

async function collect(token, accountId, now) {
  const [workers, r2, tunnels] = await Promise.all([
    settle(readWorkers(token, accountId, now), token),
    settle(readR2(token, accountId, now), token),
    settle(readTunnels(token, accountId), token),
  ]);
  const parts = { workers, r2, tunnels };
  const failed = Object.entries(parts).filter(([, value]) => value.error).map(([name]) => name);
  for (const name of failed) console.error(`[cloudflare] ${name}: ${parts[name].error}`); // iletide belirteç yok (clean)
  const pcts = [];
  if (!workers.error) pcts.push(workers.pct);
  if (!r2.error) pcts.push(r2.storagePct, r2.classAPct, r2.classBPct);
  if (!tunnels.error) pcts.push(tunnels.pct);
  const worst = pcts.length ? Math.max(...pcts) : 0;
  return {
    status: failed.length === 3 ? "error" : failed.length ? "partial" : "connected",
    level: levelOf(worst),
    worstPct: worst,
    checkedAt: now.toISOString(),
    limitsVerified: CF_LIMITS_VERIFIED,
    workers, r2, tunnels,
  };
}

// Operatör Merkezi "infra" yanıtına eklenen nesne. Hiçbir durumda istisna atmaz.
export async function cloudflareUsage({ refresh = false, now = () => new Date() } = {}) {
  const token = env("CF_ANALYTICS_TOKEN");
  const accountId = env("CF_ACCOUNT_ID");
  if (!token || !accountId) {
    return { status: "not_configured", limitsVerified: CF_LIMITS_VERIFIED, missing: [!accountId && "CF_ACCOUNT_ID", !token && "CF_ANALYTICS_TOKEN"].filter(Boolean) };
  }
  if (!/^[0-9a-f]{32}$/i.test(accountId)) return { status: "error", level: "ok", limitsVerified: CF_LIMITS_VERIFIED, error: "Okunamadı: CF_ACCOUNT_ID 32 karakterlik hesap kimliği değil" };
  const at = Date.now();
  if (cache) {
    const age = at - cache.at;
    const ttl = cache.data.status === "connected" ? CACHE_MS : ERROR_CACHE_MS;
    if (age < (refresh ? Math.min(ttl, REFRESH_MIN_MS) : ttl)) return { ...cache.data, cached: true };
  }
  if (!inflight) {
    inflight = collect(token, accountId, now())
      .catch(error => ({ status: "error", level: "ok", limitsVerified: CF_LIMITS_VERIFIED, error: `Okunamadı: ${clean(error?.message, token)}` }))
      .then(data => {
        cache = { at: Date.now(), data };
        inflight = null;
        return data;
      });
  }
  return { ...(await inflight), cached: false };
}
