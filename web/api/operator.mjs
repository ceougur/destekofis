// Operatör merkezi (/admin) API'si. Tek uç: POST /api/operator { action, args } (girişte { action: "login", password }).
// Oturum veritabanında tutulur; tarayıcıda yalnızca HttpOnly çerezde rastgele belirteç durur. İstekler özel başlık
// (x-destekofis: operator) ve aynı köken ister; çerez SameSite=Strict olduğundan başka sitelerden kullanılamaz.
import { clientIp, json, licenseKey, readJson, rpc, settings } from "./_lib/core.mjs";
import { encodeCode, signToken } from "./_lib/token.mjs";

const COOKIE = "do_op";
const SESSION_SECONDS = 12 * 3600;
const ACTIONS = new Set([
  "me", "logout", "overview", "installations", "licenses", "events", "create_license", "update_license",
  "set_license_status", "release_license", "delete_license", "license_code", "update_installation", "set_trial",
  "forget_installation", "change_password",
]);

function sessionCookie(request, value, maxAge) {
  const secure = new URL(request.url).protocol === "https:" || request.headers.get("x-forwarded-proto") === "https";
  return `${COOKIE}=${value}; Path=/api/operator; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

function readSession(request) {
  for (const part of (request.headers.get("cookie") || "").split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === COOKIE) {
      const value = rest.join("=");
      return /^[0-9a-f]{64}$/.test(value) ? value : null;
    }
  }
  return null;
}

const failure = (result, headers) => json({ ok: false, code: result.code, error: result.error }, result.status || 400, headers);

export async function POST(request) {
  const origin = request.headers.get("origin");
  if (request.headers.get("x-destekofis") !== "operator" || (origin && origin !== new URL(request.url).origin)) {
    return json({ ok: false, code: "FORBIDDEN", error: "İzin verilmeyen istek." }, 403);
  }
  const body = await readJson(request, 32_768).catch(() => null);
  if (!body) return json({ ok: false, code: "BAD_REQUEST", error: "Geçersiz istek." }, 400);
  const action = String(body.action || "");
  const args = body.args && typeof body.args === "object" && !Array.isArray(body.args) ? body.args : {};
  const ip = clientIp(request);
  try {
    const { apiSecret, keyId } = settings();
    if (action === "login") {
      const password = typeof body.password === "string" ? body.password.slice(0, 200) : "";
      const result = await rpc("lisans_operator", { p_secret: apiSecret, p_session: null, p_action: "login", p_args: { password }, p_ip: ip });
      if (!result.ok) return failure(result);
      return json({ ok: true, expiresAt: result.expiresAt }, 200, { "set-cookie": sessionCookie(request, result.token, SESSION_SECONDS) });
    }
    if (!ACTIONS.has(action)) return json({ ok: false, code: "BAD_ACTION", error: "Bilinmeyen işlem." }, 400);
    const session = readSession(request);
    if (!session) return json({ ok: false, code: "SESSION", error: "Oturumunuz kapandı. Lütfen yeniden giriş yapın." }, 401);
    const result = await rpc("lisans_operator", { p_secret: apiSecret, p_session: session, p_action: action, p_args: args, p_ip: ip });
    const headers = action === "logout" || result.code === "SESSION" ? { "set-cookie": sessionCookie(request, "", 0) } : {};
    if (!result.ok) return failure(result, headers);
    if (action === "license_code") {
      return json({ ok: true, code: encodeCode(signToken(result.claims, licenseKey(), keyId)), license: result.license });
    }
    return json(result, 200, headers);
  } catch (error) {
    console.error(`[operator] ${action}: ${error?.code || "HATA"} ${error?.message}`);
    const message = error?.code === "CONFIG" ? `Sunucu ayarı eksik: ${error.message}` : "Sunucu şu anda yanıt veremiyor. Biraz sonra tekrar deneyin.";
    return json({ ok: false, code: "SERVICE_UNAVAILABLE", error: message }, 503);
  }
}
