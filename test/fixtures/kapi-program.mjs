// 2.4.7 M3: programdaki KAPICININ lisans yanıtını okuma mantığı (kâhin = programın kendi kodu). DESTEKOFIS_PROGRAM_DIR verilirse
// program deposundaki server/lib/kapi-protokol.mjs (lisansDogrula, lisansGecerli — kapıcının kullandığı WebCrypto doğrulayıcı)
// doğrudan yüklenir; kapıcının (bulut/kapi/kapi.mjs servistenYenile + lisansGorunumu) yaptığı denetimler aşağıda aynen tekrarlanır
// ve kapi.mjs kaynağının hâlâ bu istek biçimini kullandığı denetlenir (biri değişirse test kırılır).
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const programDir = process.env.DESTEKOFIS_PROGRAM_DIR || "";
export const protokol = programDir ? await import(pathToFileURL(path.join(programDir, "server", "lib", "kapi-protokol.mjs")).href) : null;
export const kapiKaynak = programDir ? readFileSync(path.join(programDir, "bulut", "kapi", "kapi.mjs"), "utf8") : "";

// Kapıcının lisans servisine attığı istek (kapi.mjs servistenYenile ile aynı başlık ve gövde).
export const kapiIstegi = (url, anahtar, lisansKimligi, makine) =>
  new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", ...(anahtar ? { authorization: `Bearer ${anahtar}` } : {}) },
    body: JSON.stringify({ licenseId: lisansKimligi, machine: makine }),
  });

// Kapıcının yanıtı okuması: { durum: "gecerli" | "gecersiz" | "reddedildi", iddia, neden }.
export async function kapiOkur(govde, makine, guvenilen, simdi = Date.now()) {
  if (!govde?.ok || !govde.token) return { durum: "reddedildi", neden: "lisans servisi belirteç vermedi" };
  const iddia = await protokol.lisansDogrula(govde.token, guvenilen);
  if (!iddia) return { durum: "reddedildi", neden: "imza/biçim doğrulanamadı" };
  if (iddia.machine !== makine) return { durum: "reddedildi", neden: "belirteç bu ofise ait değil" };
  return { durum: protokol.lisansGecerli(iddia, simdi) ? "gecerli" : "gecersiz", iddia };
}
