import type { Metadata } from "next";
import { LegalPage } from "@/components/LegalPage";
import { SITE } from "@/lib/entity";

export const metadata: Metadata = { title: "Security" };

export default function SecurityPage() {
  return (
    <LegalPage
      title="Security"
      intro="What we do to protect client and business information, said plainly."
    >
      <h2>Payments</h2>
      <p>
        Card details are entered into Stripe&apos;s payment form and go straight to Stripe. They
        never pass through or get stored on HairMate&apos;s servers.
      </p>

      <h2>Access</h2>
      <ul>
        <li>
          The admin area uses Google sign-in, limited to approved email addresses. Anyone else is
          refused.
        </li>
        <li>Sessions are held in secure, HTTP-only cookies and can be ended at any time.</li>
        <li>
          Every change made in the admin or through the Claude assistant is recorded in an audit
          log.
        </li>
      </ul>

      <h2>Data</h2>
      <ul>
        <li>All traffic uses HTTPS, and browsers are told to insist on it.</li>
        <li>Connection tokens for Google and Xero are encrypted before they are stored.</li>
        <li>Links to manage a booking are signed, so they can&apos;t be guessed or altered.</li>
        <li>Public forms have rate limits and bot checks.</li>
        <li>
          Error reports have names, emails, phone numbers and booking links removed before they
          leave.
        </li>
      </ul>

      <h2>The Claude assistant</h2>
      <p>
        When the salon connects HairMate to Claude, reading information is instant but any change
        shows a preview and needs confirmation. Refunds and fee charges are off by default and have
        limits when switched on. Text typed by clients is treated as data and cannot instruct the
        assistant.
      </p>

      <h2>What we don&apos;t claim</h2>
      <p>
        HairMate is a small, purpose-built system. We don&apos;t hold third-party security
        certifications. We use well-established providers for payments, hosting and email, and we
        keep the amount of personal information we hold to what a salon needs.
      </p>

      <h2>Reporting a problem</h2>
      <p>
        If you think you have found a security issue, email{" "}
        <a href={`mailto:${SITE.supportEmail}`}>{SITE.supportEmail}</a> with &ldquo;Security&rdquo;
        in the subject. Please give us a reasonable chance to fix it before sharing it publicly.
      </p>
    </LegalPage>
  );
}
