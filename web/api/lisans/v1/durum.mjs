// Servis durumu: imza anahtarı yüklü mü, veritabanına ulaşılıyor mu. Gizli bilgi döndürmez.
import { json, licenseKey, rpc, settings } from "../../_lib/core.mjs";

export async function GET() {
  const { apiSecret, keyId } = settings();
  let signer = false;
  let db = false;
  try {
    licenseKey();
    signer = true;
  } catch {
    // imza anahtarı yok veya hatalı
  }
  try {
    db = (await rpc("lisans_operator", { p_secret: apiSecret, p_session: null, p_action: "ping", p_args: {}, p_ip: "" })).ok === true;
  } catch {
    // veritabanına ulaşılamadı
  }
  const ok = signer && db;
  return json({ ok, service: "DestekOfis lisans servisi", keyId, signer, db, time: new Date().toISOString() }, ok ? 200 : 503);
}
