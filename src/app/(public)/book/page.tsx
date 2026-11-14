import type { Metadata } from "next";
import { BookingFlow } from "@/components/public/BookingFlow";

export const metadata: Metadata = {
  title: "Book an appointment",
};

export default function BookPage() {
  return <BookingFlow />;
}
