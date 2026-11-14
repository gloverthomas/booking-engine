import type { Metadata } from "next";
import { ContactForm } from "@/components/ContactForm";

export const metadata: Metadata = { title: "Contact" };

export default function ContactPage() {
  return (
    <div className="wrap legal">
      <p className="eyebrow">Contact</p>
      <h1 className="display">Say hello.</h1>
      <p className="lede" style={{ marginBottom: "2.5rem" }}>
        Questions about HairMate, a support issue, or a privacy request about your information?
        Write to us and a person will reply.
      </p>
      <ContactForm />
    </div>
  );
}
