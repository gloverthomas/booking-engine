"use server";

import { headers } from "next/headers";
import { redirect, unstable_rethrow } from "next/navigation";
import { getAuth, getOwnerSession } from "@/server/auth";

const MAX_OAUTH_QUERY = 4096;

/**
 * The owner's answer to "let Claude use HairMate?". Re-checks that the person is the signed-in owner (the page
 * is not trusted) and hands the signed request back to Better Auth, which verifies it, records the consent and
 * returns where to send the client next: back to Claude with an authorization code, or with access_denied.
 */
export async function decideConsentAction(formData: FormData): Promise<void> {
  const owner = await getOwnerSession();
  if (!owner) redirect("/login");

  const oauthQuery = formData.get("oauth_query");
  if (typeof oauthQuery !== "string" || oauthQuery === "" || oauthQuery.length > MAX_OAUTH_QUERY) {
    redirect("/consent?error=expired");
  }

  let url: string | undefined;
  try {
    const result = await getAuth().api.oauth2Consent({
      body: { accept: formData.get("decision") === "allow", oauth_query: oauthQuery },
      headers: await headers(),
    });
    url = result.url;
  } catch (error) {
    unstable_rethrow(error);
  }
  if (!url) redirect("/consent?error=expired");
  redirect(url);
}
