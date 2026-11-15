import type { Metadata } from "next";
import { Suspense } from "react";
import { ClaimOfferView } from "@/components/public/waitlist/ClaimOfferView";

export const metadata: Metadata = {
  title: "A time has opened up",
  robots: { index: false, follow: false },
  // The offer token is in the URL: never leak it through the Referer header.
  referrer: "no-referrer",
};

async function Claim({ params }: Pick<PageProps<"/waitlist/claim/[token]">, "params">) {
  const { token } = await params;
  return <ClaimOfferView token={token} />;
}

export default function ClaimPage({ params }: PageProps<"/waitlist/claim/[token]">) {
  return (
    <Suspense fallback={null}>
      <Claim params={params} />
    </Suspense>
  );
}
