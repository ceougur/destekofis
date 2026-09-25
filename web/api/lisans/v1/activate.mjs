// Program: ücretsiz denemeyi başlatma ve lisans anahtarını etkinleştirme.
import { handleLicenseRequest } from "../../_lib/service.mjs";

export function POST(request) {
  return handleLicenseRequest(request, "lisans_activate");
}
