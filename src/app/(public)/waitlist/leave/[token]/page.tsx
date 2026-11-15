import type { Metadata } from "next";
import { Suspense } from "react";
import { LeaveWaitlistView } from "@/components/public/waitlist/LeaveWaitlistView";

export const metadata: Metadata = {
  title: "Leave the waitlist",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

async function Leave({ params }: Pick<PageProps<"/waitlist/leave/[token]">, "params">) {
  const { token } = await params;
  return <LeaveWaitlistView token={token} />;
}

export default function LeavePage({ params }: PageProps<"/waitlist/leave/[token]">) {
  return (
    <Suspense fallback={null}>
      <Leave params={params} />
    </Suspense>
  );
}
