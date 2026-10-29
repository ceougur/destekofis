// Programın lisans istekleri: /v1/activate ve /v1/check. Protokol programdaki docs/LISANS.md ile aynıdır:
//   istek  { product, version, machine, instanceId, kind, licenseKey?, office?, licenseId?, usage? (yalnız check) }
//   yanıt  { ok: true, token: <imzalı zarf> }  veya  { ok: false, code, error }
import { ServiceError, clientIp, json, licenseKey, readJson, rpc, settings, text } from "./core.mjs";
import { PRODUCT, normalizeLicenseKey, normalizeMachineId, signToken } from "./token.mjs";

const reject = (code, error, status = 409) => json({ ok: false, code, error }, status);

// e-Belge kullanım özeti (2.4.7; /v1/check gövdesinde usage.edoc): son 3 ayın ay × ortam başına TOPLAM sayıları.
// Yalnız izin verilen alanlar geçer (ay "YYYY-MM", ortam test/live, üç tür 0–1.000.000 tam sayı); en çok 12 satır, aynı
// (ay, ortam) bir kez. Geçersiz satır atılır, fazlası ya da biçim dışı özet tümden atılır. Hiçbir durumda isteği REDDETMEZ:
// kullanım özeti lisans doğrulamasının sonucunu değiştirmez. Aynı denetim veritabanında da yapılır (lisans.record_edoc_usage).
const USAGE_MAX_ROWS = 12;
const USAGE_MAX_COUNT = 1_000_000;
const USAGE_MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const USAGE_ENVS = new Set(["test", "live"]);
export function usageOf(value) {
  const rows = value && typeof value === "object" && !Array.isArray(value) ? value.edoc : null;
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > USAGE_MAX_ROWS) return null;
  const count = n => (Number.isSafeInteger(n) && n >= 0 && n <= USAGE_MAX_COUNT ? n : null);
  const seen = new Set();
  const edoc = [];
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const { month, env } = row;
    const efatura = count(row.efatura);
    const earsiv = count(row.earsiv);
    const esmm = count(row.esmm);
    if (typeof month !== "string" || !USAGE_MONTH.test(month) || !USAGE_ENVS.has(env) || efatura == null || earsiv == null || esmm == null) continue;
    if (seen.has(`${month}|${env}`)) continue;
    seen.add(`${month}|${env}`);
    edoc.push({ month, env, efatura, earsiv, esmm });
  }
  return edoc.length ? { edoc } : null;
}

function unavailable(error) {
  console.error(`[lisans] ${error?.code || "HATA"}: ${error?.message}`);
  return reject("SERVICE_UNAVAILABLE", "Lisans servisi şu anda yanıt veremiyor. Biraz sonra tekrar deneyin.", 503);
}

// Gövde sınırı: lisans alanları için 16 KB (önceki sınır); kullanım özeti bunun dışında sayılır ki aşırı büyük özet
// isteği reddettirmesin, yalnız kendisi atılsın. Toplam gövde 256 KB'ı aşarsa istek BAD_REQUEST olur (program bu durumda
// doğrulamayı özetsiz bir kez yineler).
const BODY_LIMIT = 16_384;
const BODY_LIMIT_WITH_USAGE = 262_144;
async function readBody(request) {
  const body = await readJson(request, BODY_LIMIT_WITH_USAGE).catch(() => null);
  if (!body) return null;
  const { usage, ...rest } = body;
  return JSON.stringify(rest).length > BODY_LIMIT ? null : body;
}

export async function handleLicenseRequest(request, fn) {
  const body = await readBody(request);
  const machine = normalizeMachineId(body?.machine);
  if (!body || body.product !== PRODUCT || !machine) return reject("BAD_REQUEST", "Geçersiz istek.", 400);
  const payload = { product: PRODUCT, machine, version: text(body.version, 20), instanceId: text(body.instanceId, 80), kind: text(body.kind, 10) };
  if (fn === "lisans_activate") {
    if (body.kind === "trial") {
      const office = body.office && typeof body.office === "object" ? body.office : {};
      payload.office = { name: text(office.name, 120), contact: text(office.contact, 120), email: text(office.email, 160), phone: text(office.phone, 40) };
    } else if (body.kind === "license") {
      const key = normalizeLicenseKey(body.licenseKey);
      if (!key) return reject("LICENSE_NOT_FOUND", "Lisans anahtarı bulunamadı.");
      payload.licenseKey = key;
    } else {
      return reject("BAD_REQUEST", "Geçersiz lisans türü.", 400);
    }
  } else {
    if (typeof body.licenseId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/.test(body.licenseId)) return reject("BAD_REQUEST", "Geçersiz istek.", 400);
    payload.licenseId = body.licenseId;
    // Denemenin 3. gününde program firma ve iletişim bilgisini bu istekle gönderir.
    if (body.office && typeof body.office === "object") {
      payload.office = { name: text(body.office.name, 120), contact: text(body.office.contact, 120), email: text(body.office.email, 160), phone: text(body.office.phone, 40) };
    }
    const usage = usageOf(body.usage);
    if (usage) payload.usage = usage;
  }
  try {
    const { apiSecret, keyId } = settings();
    const result = await rpc(fn, { p_secret: apiSecret, p_body: payload, p_ip: clientIp(request) });
    if (result.ok && result.claims) return json({ ok: true, token: signToken(result.claims, licenseKey(), keyId) });
    if (result.ok === false && typeof result.code === "string") return reject(result.code, result.error || "İstek kabul edilmedi.", result.status || 409);
    throw new ServiceError("Veritabanından beklenmeyen yanıt.");
  } catch (error) {
    return unavailable(error);
  }
}
