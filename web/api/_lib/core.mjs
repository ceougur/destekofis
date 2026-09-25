// Lisans API'sinin ortak parçaları: ortam ayarları, imza anahtarı, Supabase çağrısı, JSON yanıtları.
//
// Ortam değişkenleri (Vercel → Settings → Environment Variables; gizli olanlar "Sensitive"):
//   SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY  Supabase adresi ve herkese açık anahtar
//   DESTEKOFIS_API_SECRET                   Veritabanı fonksiyonlarının istediği sır (veritabanında yalnızca özeti var)
//   DESTEKOFIS_LICENSE_KEY                  Lisans imza anahtarı (Ed25519, PEM)
//   DESTEKOFIS_LICENSE_KEY_ID               Anahtar kimliği (varsayılan destekofis-lisans-2026-1)
import { createPrivateKey } from "node:crypto";

export class ServiceError extends Error {
  constructor(message, code = "SERVICE_UNAVAILABLE", status = 503) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const env = name => String(process.env[name] || "").trim();

export function settings() {
  return {
    supabaseUrl: env("SUPABASE_URL").replace(/\/+$/, ""),
    supabaseKey: env("SUPABASE_PUBLISHABLE_KEY"),
    apiSecret: env("DESTEKOFIS_API_SECRET"),
    keyId: env("DESTEKOFIS_LICENSE_KEY_ID") || "destekofis-lisans-2026-1",
  };
}

let signingKey = null;
export function licenseKey() {
  if (signingKey) return signingKey;
  let pem = env("DESTEKOFIS_LICENSE_KEY").replace(/\\n/g, "\n");
  if (pem && !pem.includes("-----BEGIN")) pem = Buffer.from(pem, "base64").toString("utf8");
  if (!pem) throw new ServiceError("Lisans imza anahtarı tanımlı değil.", "CONFIG");
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== "ed25519") throw new ServiceError("Lisans imza anahtarı Ed25519 değil.", "CONFIG");
  signingKey = key;
  return key;
}

// Supabase'deki SECURITY DEFINER fonksiyonunu çağırır (PostgREST RPC). Yanıt JSON nesnesidir.
export async function rpc(name, args) {
  const { supabaseUrl, supabaseKey } = settings();
  if (!supabaseUrl || !supabaseKey) throw new ServiceError("Veritabanı bağlantısı tanımlı değil.", "CONFIG");
  let response;
  try {
    response = await fetch(`${supabaseUrl}/rest/v1/rpc/${name}`, {
      method: "POST",
      headers: { apikey: supabaseKey, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    throw new ServiceError(`Veritabanına ulaşılamadı (${error.name}).`);
  }
  const text = await response.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    // aşağıda ele alınır
  }
  if (!response.ok || !data || typeof data !== "object" || Array.isArray(data)) {
    console.error(`[rpc] ${name} HTTP ${response.status}: ${text.slice(0, 300)}`);
    throw new ServiceError(`Veritabanı isteği başarısız (HTTP ${response.status}).`);
  }
  if (data.ok === false && data.code === "UNAUTHORIZED") {
    throw new ServiceError("Sunucu yapılandırması hatalı: API sırrı veritabanıyla eşleşmiyor.", "CONFIG");
  }
  return data;
}

export const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", ...headers },
  });

export async function readJson(request, limit = 16_384) {
  const text = await request.text();
  if (text.length > limit) return null;
  try {
    const value = JSON.parse(text || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

// Vercel, istemcinin gerçek adresini x-real-ip / x-forwarded-for başlığında verir (dışarıdan gelen değeri ezer).
export const clientIp = request =>
  (request.headers.get("x-real-ip") || request.headers.get("x-forwarded-for")?.split(",")[0] || "").trim().slice(0, 64);

export const text = (value, max) => (typeof value === "string" ? value.trim().slice(0, max) : "");
