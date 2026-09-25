// Lisans belirteci: biçim, Ed25519 imzası ve internetsiz etkinleştirme kodu.
// Programdaki server/lib/license-token.mjs ile AYNI biçimi üretir; biri değişirse diğeri de değişmeli.
//   Zarf: { "schema": 1, "payload": "<base64(JSON iddialar)>", "signatures": [{ "keyId": "...", "sig": "<base64>" }] }
//   Kod:  "DOLIS1." + base64url(JSON zarf)
import { sign } from "node:crypto";

export const TOKEN_SCHEMA = 1;
export const TOKEN_TYPE = "license-token";
export const PRODUCT = "DestekOfis";
export const CODE_PREFIX = "DOLIS1.";
const KINDS = new Set(["trial", "license"]);
const STATUSES = new Set(["active", "blocked"]);

const isoOrNull = value => {
  if (value == null || value === "") return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
};

export const normalizeMachineId = value => {
  const clean = String(value ?? "").replace(/[\s-]/g, "").toLowerCase();
  return /^[a-f0-9]{32}$/.test(clean) ? clean : null;
};

// Crockford base32: O → 0, I/L → 1 okunur. "DO-" öneki yazılmasa da kabul edilir.
const LICENSE_KEY = /^DO(?:-[0-9A-HJKMNP-TV-Z]{5}){4}$/;
export const normalizeLicenseKey = value => {
  const compact = String(value ?? "").toUpperCase().replace(/[^0-9A-Z]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  const body = compact.length === 22 && compact.startsWith("D0") ? compact.slice(2) : compact;
  if (body.length !== 20) return null;
  const key = `DO-${body.match(/.{5}/g).join("-")}`;
  return LICENSE_KEY.test(key) ? key : null;
};

export function normalizeClaims(value) {
  const fail = detail => {
    throw new Error(`Lisans bilgisi geçersiz (${detail}).`);
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
  };
}

// privateKey: node:crypto KeyObject (Ed25519).
export function signToken(claims, privateKey, keyId) {
  if (privateKey?.asymmetricKeyType !== "ed25519") throw new Error("Lisans imza anahtarı Ed25519 olmalı.");
  if (!keyId) throw new Error("Anahtar kimliği (keyId) gerekli.");
  const payload = Buffer.from(JSON.stringify(normalizeClaims(claims)), "utf8");
  return { schema: TOKEN_SCHEMA, payload: payload.toString("base64"), signatures: [{ keyId, sig: sign(null, payload, privateKey).toString("base64") }] };
}

export const encodeCode = envelope => CODE_PREFIX + Buffer.from(JSON.stringify(envelope), "utf8").toString("base64url");
