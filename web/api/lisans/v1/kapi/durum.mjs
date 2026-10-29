// Mobil kapıcı (Cloudflare Worker): ofis sunucusu kapalıyken lisansın güncel durumu. Salt okur; kurulum kaydını değiştirmez.
// Ayrıntı: ../../../_lib/service.mjs handleKapiRequest.
import { handleKapiRequest } from "../../../_lib/service.mjs";

export function POST(request) {
  return handleKapiRequest(request);
}
