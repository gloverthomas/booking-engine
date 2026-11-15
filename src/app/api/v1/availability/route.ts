import { z } from "zod";
import { seesAllStaff } from "@/server/auth/permissions";
import { getAvailableSlots } from "@/server/availability";
import { parseQuery, readApi } from "@/server/api/handler";
import { ApiError } from "@/server/api/respond";

const MAX_SPAN_DAYS = 14;
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

const query = z
  .object({
    locationId: z.uuid(),
    serviceIds: z
      .string()
      .transform((v) => v.split(",").filter(Boolean))
      .pipe(z.array(z.uuid()).min(1, "Choose at least one service").max(10)),
    fromDate: date,
    toDate: date,
    staffId: z.uuid().optional(),
  })
  .refine((q) => q.toDate >= q.fromDate, { message: "toDate is before fromDate", path: ["toDate"] })
  .refine((q) => (Date.parse(q.toDate) - Date.parse(q.fromDate)) / 86_400_000 <= MAX_SPAN_DAYS, {
    message: `Ask for at most ${MAX_SPAN_DAYS + 1} days at a time`,
    path: ["toDate"],
  });

/**
 * GET /api/v1/availability?locationId=&serviceIds=a,b&fromDate=&toDate=&staffId=
 * Open start times, priced for each stylist, from the same engine the booking page uses. Omit staffId for
 * "first available". A stylist can only ask about themselves.
 */
export async function GET(request: Request) {
  return readApi(["booking.create"], request, async ({ db, access }) => {
    const q = parseQuery(request, query);
    let staffId = q.staffId;
    if (!seesAllStaff(access.role)) {
      if (staffId && staffId !== access.staffId) {
        throw new ApiError(403, "forbidden", "You do not have permission to do that");
      }
      staffId = access.staffId ?? undefined;
    }
    const slots = await getAvailableSlots(db, { ...q, staffId });
    return { slots };
  });
}
