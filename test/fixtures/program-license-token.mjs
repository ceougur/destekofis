// Lisans belirteci (token): biçim, Ed25519 imzası ve internetsiz etkinleştirme kodu.
//
// Lisans servisi (Faz 4: Vercel) ve operatör araçları belirteci imzalar; uygulama yalnızca gömülü AÇIK anahtarlardan
// biriyle imzalı belirteci kabul eder (server/lib/license-keys.mjs). Zarf, güncelleme bildirgesiyle aynı biçimdedir:
//   { "schema": 1, "payload": "<base64(JSON iddialar)>", "signatures": [{ "keyId": "...", "sig": "<base64>" }] }
// İmza payload'un ham baytları üzerinedir. İddialar (claims):
//   { schema, product, type: "license-token", kind: "trial"|"license", status: "active"|"blocked",
//     licenseId, customer, machine (32 hex), issuedAt, startsAt, expiresAt (null = süresiz), offline, message, mobileDevices? (2.4.7 M2) }
// "issuedAt" servisin saatidir: uygulama saat geri alma denetiminde ve 7 günlük internetsiz toleransta buna güvenir.
// İnternetsiz etkinleştirme kodu aynı zarfın tek satırlık hâlidir: "DOLIS1." + base64url(JSON zarf).
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";

export const TOKEN_SCHEMA = 1;
export const TOKEN_TYPE = "license-token";
export const PRODUCT = "DestekOfis";
export const CODE_PREFIX = "DOLIS1.";
export const MAX_TOKEN_BYTES = 16 * 1024;
const KINDS = new Set(["trial", "license"]);
const STATUSES = new Set(["active", "blocked"]);

export class LicenseError extends Error {
  constructor(message, code = "LICENSE_INVALID") {
    super(message);
    this.name = "LicenseError";
    this.code = code;
  }
}

const isoOrNull = value => {
  if (value == null || value === "") return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
};

// Bilgisayar kimliği: 32 onaltılık karakter (küçük harf). Kurulum kodu olarak gösterilirken 4'lü gruplanır.
export const normalizeMachineId = value => {
  const clean = String(value ?? "").replace(/[\s-]/g, "").toLowerCase();
  return /^[a-f0-9]{32}$/.test(clean) ? clean : null;
};
export const formatInstallCode = machineId => (normalizeMachineId(machineId) || "").toUpperCase().match(/.{4}/g)?.join("-") || "";

export function normalizeClaims(value) {
  const fail = detail => {
    throw new LicenseError(`Lisans bilgisi geçersiz (${detail}).`);
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("nesne değil");
  if (value.schema !== TOKEN_SCHEMA) fail("şema");
  if (value.product !== PRODUCT) fail("ürün");
  if (value.type !== TOKEN_TYPE) fail("tür");
  if (!KINDS.has(value.kind)) fail("lisans türü");
  const status = value.status ?? "active";
  if (!STATUSES.has(status)) fail("durum");
  if (typeof value.licenseId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/.test(value.licenseId)) fail("lisans numarası");
  const machine = normalizeMachineId(value.machine);
  if (!machine) fail("bilgisayar kimliği");
  const issuedAt = isoOrNull(value.issuedAt);
  if (!issuedAt) fail("düzenlenme zamanı");
  const startsAt = isoOrNull(value.startsAt ?? value.issuedAt);
  if (!startsAt) fail("başlangıç zamanı");
  const expiresAt = isoOrNull(value.expiresAt);
  if (expiresAt === undefined) fail("bitiş zamanı");
  if (value.kind === "trial" && !expiresAt) fail("deneme süresinin bitişi");
  return {
    schema: TOKEN_SCHEMA,
    product: PRODUCT,
    type: TOKEN_TYPE,
    kind: value.kind,
    status,
    licenseId: value.licenseId,
    customer: typeof value.customer === "string" ? value.customer.trim().slice(0, 120) : "",
    machine,
    issuedAt,
    startsAt,
    expiresAt,
    offline: value.offline === true,
    message: typeof value.message === "string" ? value.message.trim().slice(0, 300) : "",
    // 2.4.7 M2: program başına en çok eşli uzaktan cihaz (telefon, tablet, uzak tarayıcı; iki şirket birlikte). İsteğe bağlı; yoksa program 3 sayar
    // (lib/license.mjs mobileDeviceLimit). Yalnız geçerli tam sayıda iddiaya girer (eski belirteçlerin biçimi değişmez).
    ...(Number.isInteger(value.mobileDevices) && value.mobileDevices >= 0 && value.mobileDevices <= 100 ? { mobileDevices: value.mobileDevices } : {}),
  };
}

export function signToken(claims, privateKeyPem, keyId) {
  const key = createPrivateKey(privateKeyPem);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Lisans imza anahtarı Ed25519 olmalı.");
  if (!keyId) throw new Error("Anahtar kimliği (keyId) gerekli.");
  const payload = Buffer.from(JSON.stringify(normalizeClaims(claims)), "utf8");
  return { schema: TOKEN_SCHEMA, payload: payload.toString("base64"), signatures: [{ keyId, sig: sign(null, payload, key).toString("base64") }] };
}

const keyCache = new Map();
function trustedKey(keyId, trustedKeys) {
  const encoded = Object.hasOwn(trustedKeys, keyId) ? trustedKeys[keyId] : null;
  if (typeof encoded !== "string") return null;
  if (!keyCache.has(encoded)) {
    const key = createPublicKey({ key: Buffer.from(encoded, "base64"), format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "ed25519") throw new Error(`Güvenilen lisans anahtarı Ed25519 değil: ${keyId}`);
    keyCache.set(encoded, key);
  }
  return keyCache.get(encoded);
}

// Zarfı doğrular; güvenilen anahtarlardan biriyle geçerli imza yoksa LicenseError fırlatır.
export function verifyToken(envelope, trustedKeys) {
  if (!envelope || typeof envelope !== "object" || envelope.schema !== TOKEN_SCHEMA || typeof envelope.payload !== "string" || !Array.isArray(envelope.signatures)) {
    throw new LicenseError("Lisans bilgisinin biçimi tanınmadı.", "TOKEN_FORMAT");
  }
  const payload = Buffer.from(envelope.payload, "base64");
  if (!payload.length || payload.length > MAX_TOKEN_BYTES) throw new LicenseError("Lisans bilgisi boş veya çok büyük.", "TOKEN_FORMAT");
  let keyId = null;
  for (const item of envelope.signatures.slice(0, 8)) {
    if (!item || typeof item.keyId !== "string" || typeof item.sig !== "string") continue;
    const key = trustedKey(item.keyId, trustedKeys);
    const signature = Buffer.from(item.sig, "base64");
    if (!key || signature.length !== 64) continue;
    if (verify(null, payload, key, signature)) {
      keyId = item.keyId;
      break;
    }
  }
  if (!keyId) throw new LicenseError("Lisans bilgisinin imzası doğrulanamadı.", "SIGNATURE_INVALID");
  let parsed;
  try {
    parsed = JSON.parse(payload.toString("utf8"));
  } catch {
    throw new LicenseError("Lisans bilgisi okunamadı.", "TOKEN_FORMAT");
  }
  return { claims: normalizeClaims(parsed), keyId };
}

// İnternetsiz etkinleştirme kodu ⇄ zarf.
export const encodeCode = envelope => CODE_PREFIX + Buffer.from(JSON.stringify(envelope), "utf8").toString("base64url");
export function decodeCode(code) {
  const text = String(code ?? "").replace(/\s+/g, "");
  if (!text.startsWith(CODE_PREFIX)) throw new LicenseError("Etkinleştirme kodu \"DOLIS1.\" ile başlamalı. Kodu eksiksiz kopyaladığınızdan emin olun.", "CODE_FORMAT");
  const body = text.slice(CODE_PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(body) || body.length > MAX_TOKEN_BYTES * 2) throw new LicenseError("Etkinleştirme kodu bozuk görünüyor.", "CODE_FORMAT");
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    throw new LicenseError("Etkinleştirme kodu bozuk görünüyor.", "CODE_FORMAT");
  }
}
