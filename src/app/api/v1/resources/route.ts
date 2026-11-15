import { listCalendarResources } from "@/server/admin/calendar";
import { CALENDAR_PERMISSIONS } from "@/server/admin/session";
import { readApi } from "@/server/api/handler";

/**
 * GET /api/v1/resources : what the create-appointment form needs: locations, the stylists this person
 * may see (a stylist sees only themselves), active services with prices, and the business's slot size.
 */
export async function GET(request: Request) {
  return readApi(CALENDAR_PERMISSIONS, request, ({ db, access }) =>
    listCalendarResources(db, access),
  );
}
