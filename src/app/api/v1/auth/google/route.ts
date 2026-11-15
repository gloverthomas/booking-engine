import { APIError } from "better-auth/api";
import { getDb } from "@/db/client";
import { getAuth } from "@/server/auth";
import { parseOwnerEmails } from "@/server/auth/owners";
import { resolveAccess } from "@/server/auth/resolve-access";
import { parseBody } from "@/server/api/handler";
import { ApiError, errorResponse, failure, ok } from "@/server/api/respond";
import { googleSignInSchema, ownerEmailsRaw } from "@/server/api/session";

const REFUSED =
  "That Google account is not allowed to sign in. Use the account Ryan added for you.";

/**
 * POST /api/v1/auth/google { idToken }
 * Exchanges a Google ID token (from native sign-in) for a bearer token. It goes through the same Better Auth
 * instance as the web: the same allow-list (OWNER_EMAILS plus active staff), the same session table, the
 * same revocation. Send the token as `Authorization: Bearer <token>` on every other call.
 */
export async function POST(request: Request) {
  try {
    const { idToken, nonce } = await parseBody(request, googleSignInSchema);
    const auth = getAuth();
    const { headers, response } = await auth.api.signInSocial({
      body: { provider: "google", idToken: { token: idToken, nonce }, disableRedirect: true },
      headers: request.headers,
      returnHeaders: true,
    });
    const token = headers.get("set-auth-token");
    const user = "user" in response ? response.user : undefined;
    if (!token || !user) return failure(401, { code: "sign_in_refused", message: REFUSED });

    const access = await resolveAccess(
      getDb(),
      { id: user.id, email: user.email, name: user.name },
      parseOwnerEmails(ownerEmailsRaw()),
    );
    if (!access) return failure(403, { code: "not_authorised", message: REFUSED });
    return ok({
      token,
      user: { id: user.id, email: user.email, name: user.name ?? null },
      role: access.role,
      staffId: access.staffId,
    });
  } catch (error) {
    if (error instanceof APIError) {
      return errorResponse(new ApiError(401, "sign_in_refused", REFUSED));
    }
    return errorResponse(error);
  }
}
