import type { Metadata } from "next";
import { Suspense } from "react";
import { ManageView } from "@/components/public/ManageView";

export const metadata: Metadata = {
  title: "Manage your booking",
  robots: { index: false, follow: false },
  // The manage token is in the URL: never leak it through the Referer header.
  referrer: "no-referrer",
};

async function Manage({ params }: Pick<PageProps<"/manage/[token]">, "params">) {
  const { token } = await params;
  return <ManageView token={token} />;
}

export default function ManagePage({ params }: PageProps<"/manage/[token]">) {
  return (
    <Suspense fallback={null}>
      <Manage params={params} />
    </Suspense>
  );
}
