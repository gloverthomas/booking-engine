"use server";

import { headers } from "next/headers";
import { redirect, unstable_rethrow } from "next/navigation";
import { ADMIN_HOME } from "@/components/admin/shell/nav-config";
import { getAuth } from "@/server/auth";

const OAUTH_QUERY_FIELD = "oauth_query";
const MAX_OAUTH_QUERY = 4096;

/**
 * Starts Google sign-in. Better Auth stores the OAuth state and PKCE verifier in cookies and
 * returns Google's authorisation URL; the callback (/api/auth/callback/google) enforces the owner allow-list.
 * Failures come back to /login?error=<code>, which the page turns into a plain-English message.
 */
export async function signInWithGoogleAction(formData: FormData): Promise<void> {
  // Present only when Claude (or another MCP client) sent the owner here to sign in: Better Auth resumes that
  // authorization after Google, and verifies the signature, so a forged value is refused.
  const oauthQuery = formData.get(OAUTH_QUERY_FIELD);
  let url: string | undefined;
  try {
    const result = await getAuth().api.signInSocial({
      body: {
        provider: "google",
        callbackURL: ADMIN_HOME,
        errorCallbackURL: "/login",
        ...(typeof oauthQuery === "string" && oauthQuery !== "" && oauthQuery.length <= MAX_OAUTH_QUERY
          ? { oauth_query: oauthQuery }
          : {}),
      },
      headers: await headers(),
    });
    url = result.url;
  } catch (error) {
    unstable_rethrow(error);
  }
  if (!url) redirect("/login?error=unable_to_start");
  redirect(url);
}
