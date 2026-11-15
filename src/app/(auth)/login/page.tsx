import { redirect } from "next/navigation";
import { Suspense } from "react";
import { GoogleSignInButton } from "@/components/admin/shell/google-sign-in-button";
import { ADMIN_HOME } from "@/components/admin/shell/nav-config";
import { Alert } from "@/components/ui/alert";
import { getAccessSession } from "@/server/auth";
import { loginErrorMessage } from "@/server/auth/owners";
import { signInWithGoogleAction } from "./actions";

type SearchParams = Promise<{ [key: string]: string | string[] | undefined }>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default function LoginPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <main className="grid min-h-dvh grid-rows-[1fr_auto] bg-peach px-[var(--space-page)] pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-8 lg:grid-cols-[1.2fr_1fr] lg:grid-rows-1 lg:gap-16 lg:p-16">
      <div className="flex flex-col justify-between gap-10">
        <p className="eyebrow !text-ink">Hairdressing admin</p>
        <h1 className="display text-[clamp(3.5rem,2rem+10vw,9rem)] text-ink">
          Ryan
          <br />
          Kennedy
        </h1>
      </div>

      <section
        aria-labelledby="signin-heading"
        className="mt-10 flex flex-col justify-end gap-5 border-t-[3px] border-ink pt-6 lg:mt-0 lg:max-w-sm lg:justify-center lg:self-end"
      >
        <h2 id="signin-heading" className="display text-3xl text-ink">
          Sign in
        </h2>
        <Suspense fallback={<SignInPanelSkeleton />}>
          <SignInPanel searchParams={searchParams} />
        </Suspense>
        <p className="text-sm text-ink-muted">
          Only the owner and the team they have added can sign in, each with their own Google
          account. Clients book on the public booking page.
        </p>
      </section>
    </main>
  );
}

async function SignInPanel({ searchParams }: { searchParams: SearchParams }) {
  const [params, session] = await Promise.all([searchParams, getAccessSession()]);
  if (session) redirect(ADMIN_HOME);
  const message = loginErrorMessage(first(params.error));
  return (
    <>
      {message ? <Alert tone="danger">{message}</Alert> : null}
      <form action={signInWithGoogleAction}>
        <GoogleSignInButton />
      </form>
    </>
  );
}

function SignInPanelSkeleton() {
  return (
    <div
      aria-hidden
      className="h-13 animate-pulse rounded-control bg-ink/10 motion-reduce:animate-none"
    />
  );
}
