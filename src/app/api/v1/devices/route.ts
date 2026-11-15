import { z } from "zod";
import { commandApi, parseBody } from "@/server/api/handler";
import { ApiError } from "@/server/api/respond";
import { registerDevice, unregisterDevice } from "@/server/push";

const body = z.object({ token: z.string().trim().min(10).max(300) });

/** Anyone who can sign in may receive notifications on their own phone. */
const ANY_STAFF = ["calendar.viewAll", "calendar.viewOwn"] as const;

function ownStaffId(ctx: { access: { staffId: string | null } }): string {
  if (!ctx.access.staffId) {
    throw new ApiError(409, "invalid_state", "Your login is not linked to a staff profile yet.");
  }
  return ctx.access.staffId;
}

/**
 * POST /api/v1/devices { token } : register this phone's Expo push token for the signed-in person. Call it
 * after every sign-in; it is idempotent and moves the phone to whoever signed in last.
 */
export async function POST(request: Request) {
  return commandApi([...ANY_STAFF], request, async (ctx) => {
    const { token } = await parseBody(request, body);
    await registerDevice(ctx.db, ownStaffId(ctx), token);
    return { registered: true };
  });
}

/** DELETE /api/v1/devices { token } : stop notifying this phone (sign-out). Safe to repeat. */
export async function DELETE(request: Request) {
  return commandApi([...ANY_STAFF], request, async (ctx) => {
    const { token } = await parseBody(request, body);
    await unregisterDevice(ctx.db, ownStaffId(ctx), token);
    return { registered: false };
  });
}
