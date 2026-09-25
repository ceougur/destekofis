// Programın lisans istekleri: /v1/activate ve /v1/check. Protokol programdaki docs/LISANS.md ile aynıdır:
//   istek  { product, version, machine, instanceId, kind, licenseKey?, office?, licenseId? }
//   yanıt  { ok: true, token: <imzalı zarf> }  veya  { ok: false, code, error }
import { ServiceError, clientIp, json, licenseKey, readJson, rpc, settings, text } from "./core.mjs";
import { PRODUCT, normalizeLicenseKey, normalizeMachineId, signToken } from "./token.mjs";

const reject = (code, error, status = 409) => json({ ok: false, code, error }, status);

function unavailable(error) {
  console.error(`[lisans] ${error?.code || "HATA"}: ${error?.message}`);
  return reject("SERVICE_UNAVAILABLE", "Lisans servisi şu anda yanıt veremiyor. Biraz sonra tekrar deneyin.", 503);
}

export async function handleLicenseRequest(request, fn) {
  const body = await readJson(request).catch(() => null);
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
