import type { Metadata } from "next";
import { Suspense } from "react";
import { z } from "zod";
import { JoinWaitlistView } from "@/components/public/waitlist/JoinWaitlistView";

export const metadata: Metadata = {
  title: "Join the waitlist",
  robots: { index: false, follow: false },
};

const querySchema = z.object({
  location: z.uuid().optional(),
  services: z
    .string()
    .transform((v) => v.split(",").filter(Boolean))
    .pipe(z.array(z.uuid()).max(10))
    .optional(),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  staff: z.uuid().optional(),
});

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

async function Join({ searchParams }: Pick<PageProps<"/waitlist/join">, "searchParams">) {
  const raw = await searchParams;
  const parsed = querySchema.safeParse({
    location: first(raw.location),
    services: first(raw.services),
    date: first(raw.date),
    staff: first(raw.staff),
  });
  const query = parsed.success ? parsed.data : {};
  return (
    <JoinWaitlistView
      locationId={query.location}
      serviceIds={query.services ?? []}
      date={query.date}
      staffId={query.staff}
    />
  );
}

export default function JoinWaitlistPage({ searchParams }: PageProps<"/waitlist/join">) {
  return (
    <Suspense fallback={null}>
      <Join searchParams={searchParams} />
    </Suspense>
  );
}
