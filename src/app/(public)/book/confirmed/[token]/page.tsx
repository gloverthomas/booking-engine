import type { Metadata } from "next";
import { Suspense } from "react";
import { ConfirmedView } from "@/components/public/ConfirmedView";

export const metadata: Metadata = {
  title: "Booking confirmed",
  robots: { index: false, follow: false },
  // The manage token is in the URL: never leak it through the Referer header.
  referrer: "no-referrer",
};

async function Confirmed({ params }: Pick<PageProps<"/book/confirmed/[token]">, "params">) {
  const { token } = await params;
  return <ConfirmedView token={token} />;
}

export default function ConfirmedPage({ params }: PageProps<"/book/confirmed/[token]">) {
  return (
    <Suspense fallback={null}>
      <Confirmed params={params} />
    </Suspense>
  );
}
