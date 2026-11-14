"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { ADMIN_HOME } from "@/components/admin/shell/nav-config";
import { getAuth } from "@/server/auth";

/**
 * Starts Google sign-in. Better Auth stores the OAuth state and PKCE verifier in cookies and
 * returns Google's authorisation URL; the callback (/api/auth/callback/google) enforces the owner allow-list.
 * Failures come back to /login?error=<code>, which the page turns into a plain-English message.
 */
export async function signInWithGoogleAction(): Promise<void> {
  const result = await getAuth().api.signInSocial({
    body: {
      provider: "google",
      callbackURL: ADMIN_HOME,
      errorCallbackURL: "/login",
    },
    headers: await headers(),
  });
  if (!result.url) redirect("/login?error=unable_to_start");
  redirect(result.url);
}
