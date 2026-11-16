import { verifyOAuthQueryParams } from "@better-auth/oauth-provider";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { getAccessSession, getAuth } from "@/server/auth";
import { signedOAuthQuery } from "@/server/auth/oauth-query";
import { decideConsentAction } from "./actions";

type SearchParams = Promise<{ [key: string]: string | string[] | undefined }>;

/** What a connected MCP client can do, in the owner's words. Keep in step with src/server/mcp/tools. */
const CAN_DO = [
  "See bookings, clients, availability, takings and cancellations",
  "Create, move and cancel bookings, block time, edit services and add client notes",
  "Message clients",
];

export default function ConsentPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <main className="grid min-h-dvh place-items-center bg-peach px-[var(--space-page)] py-10">
      <section
        aria-labelledby="consent-heading"
        className="flex w-full max-w-md flex-col gap-5 border-t-[3px] border-ink pt-6"
      >
        <p className="eyebrow !text-ink">Hairdressing admin</p>
        <Suspense fallback={<div aria-hidden className="h-40 animate-pulse rounded-card bg-ink/10" />}>
          <ConsentPanel searchParams={searchParams} />
        </Suspense>
      </section>
    </main>
  );
}

async function ConsentPanel({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const oauthQuery = signedOAuthQuery(params);
  if (!oauthQuery) {
    return (
      <Problem>
        This page opens when Claude asks to connect. Start from the connector in Claude.
      </Problem>
    );
  }

  const auth = getAuth();
  const { secret } = await auth.$context;
  if (!(await verifyOAuthQueryParams(oauthQuery, secret))) {
    return <Problem>This request has expired. Start again from the connector in Claude.</Problem>;
  }

  const session = await getAccessSession();
  // Keep the signed request so signing in carries on to this screen.
  if (!session) redirect(`/login?${oauthQuery}`);
  if (session.role !== "owner") {
    return <Problem>Only the owner can connect Claude. Sign in with the owner&rsquo;s Google account.</Problem>;
  }

  const clientId = new URLSearchParams(oauthQuery).get("client_id") ?? "";
  const client = await auth.api
    .getOAuthClientPublic({ query: { client_id: clientId }, headers: await headers() })
    .catch(() => null);
  if (!client) return <Problem>That app isn&rsquo;t recognised, so it can&rsquo;t be connected.</Problem>;

  const name = client.client_name ?? "An app";
  return (
    <>
      <h1 id="consent-heading" className="display text-3xl text-ink">
        Let {name} use HairMate?
      </h1>
      <p className="text-ink-muted">
        Signed in as <strong className="text-ink">{session.email}</strong>. If you approve, {name} (
        {hostOf(clientId)}) will be able to:
      </p>
      <ul className="flex list-disc flex-col gap-1.5 pl-5 text-ink">
        {CAN_DO.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <p className="text-sm text-ink-muted">
        Changes show a preview and need your confirmation in Claude first. You can disconnect any time.
      </p>
      <form action={decideConsentAction} className="flex flex-col gap-3">
        <input type="hidden" name="oauth_query" value={oauthQuery} />
        <Button type="submit" name="decision" value="allow" size="lg" fullWidth>
          Allow
        </Button>
        <Button type="submit" name="decision" value="deny" variant="secondary" size="lg" fullWidth>
          Deny
        </Button>
      </form>
    </>
  );
}

function Problem({ children }: { children: string }) {
  return (
    <>
      <h1 id="consent-heading" className="display text-3xl text-ink">
        Can&rsquo;t connect
      </h1>
      <Alert tone="danger">{children}</Alert>
    </>
  );
}

function hostOf(clientId: string): string {
  try {
    return new URL(clientId).hostname;
  } catch {
    return "unknown source";
  }
}
