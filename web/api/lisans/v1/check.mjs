// Program: lisansın düzenli doğrulanması (12 saatte bir ve açılışta).
import { handleLicenseRequest } from "../../_lib/service.mjs";

export function POST(request) {
  return handleLicenseRequest(request, "lisans_check");
}
