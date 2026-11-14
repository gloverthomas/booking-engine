import type { Metadata } from "next";
import { LegalPage, Operator } from "@/components/LegalPage";
import { SITE, readEntity } from "@/lib/entity";

export const metadata: Metadata = { title: "Privacy policy" };

export default function PrivacyPage() {
  const entity = readEntity();
  return (
    <LegalPage
      title="Privacy policy"
      intro="What we collect when you book, why, who handles it, and how to ask us to change or delete it."
    >
      <h2>Who we are</h2>
      <p>
        HairMate is the booking system used by Ryan Kennedy Hairdressing. It is operated by{" "}
        <Operator />
        {entity.address !== "to be confirmed" ? `, ${entity.address}` : ""} (&ldquo;we&rdquo;). We
        follow the Australian Privacy Principles. Questions or requests:{" "}
        <a href={`mailto:${SITE.privacyEmail}`}>{SITE.privacyEmail}</a>.
      </p>

      <h2>What we collect</h2>
      <ul>
        <li>
          <strong>When you book:</strong> your name, email address and mobile number; optionally
          your pronouns, another phone number, a company name and comments; the services, time and
          location you chose; answers to any service questions; whether you ticked the marketing
          box; and when you accepted the cancellation policy and which version.
        </li>
        <li>
          <strong>Payments:</strong> you enter card details directly with Stripe. We never see or
          store your full card number. We keep a Stripe customer reference, payment references,
          amounts and statuses, and Stripe saves your card so a no-show or late-cancellation fee can
          be charged if the policy applies.
        </li>
        <li>
          <strong>Messages:</strong> a record of the emails and text messages we send you (what,
          when, to which address or number, and whether it was delivered).
        </li>
        <li>
          <strong>Salon records:</strong> your appointment history and any notes the stylist keeps
          about your appointments.
        </li>
        <li>
          <strong>Technical:</strong> your IP address and browser details, used for security and to
          limit abuse. Error reports are sent to a monitoring service after names, emails, phone
          numbers and booking links are removed.
        </li>
        <li>
          <strong>On your device:</strong> the booking page can remember your details in your
          browser to speed up rebooking (you can clear them on the page). Staff sign-in uses a
          session cookie. We use no advertising or tracking cookies.
        </li>
      </ul>

      <h2>Why we use it</h2>
      <ul>
        <li>To make, change and cancel your appointment and hold your slot while you pay.</li>
        <li>To take deposits and charge fees under the cancellation policy you accepted.</li>
        <li>To send confirmations, reminders and notices about your booking.</li>
        <li>To keep tax and accounting records, including invoices.</li>
        <li>To keep the service secure and prevent abuse, and to meet legal obligations.</li>
        <li>For marketing messages only if you ticked the box, and you can stop them any time.</li>
      </ul>
      <p>We do not sell your information or use it for advertising.</p>

      <h2>Who handles your information</h2>
      <p>We use these service providers. Each only receives what it needs to do its job.</p>
      <table>
        <thead>
          <tr>
            <th scope="col">Provider</th>
            <th scope="col">What for</th>
            <th scope="col">Where</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Stripe</td>
            <td>Card payments, saved cards, refunds</td>
            <td>Global (including the US)</td>
          </tr>
          <tr>
            <td>Railway</td>
            <td>Hosting and the database</td>
            <td>United States</td>
          </tr>
          <tr>
            <td>Resend</td>
            <td>Sending email</td>
            <td>United States</td>
          </tr>
          <tr>
            <td>SMS gateway</td>
            <td>Sending text messages</td>
            <td>Australia or overseas, depending on the gateway</td>
          </tr>
          <tr>
            <td>Xero</td>
            <td>Invoices and accounting (your name, email and the invoice)</td>
            <td>Australia/New Zealand and overseas</td>
          </tr>
          <tr>
            <td>Google</td>
            <td>
              The stylist&apos;s own calendar, and staff sign-in. Your name, services and phone
              number appear in the stylist&apos;s calendar entry.
            </td>
            <td>Global</td>
          </tr>
          <tr>
            <td>Sentry</td>
            <td>Error monitoring (details removed)</td>
            <td>United States</td>
          </tr>
          <tr>
            <td>Cloudflare</td>
            <td>Bot protection on forms, and DNS</td>
            <td>Global</td>
          </tr>
        </tbody>
      </table>
      <p>
        This means some of your information is held outside Australia, mainly in the United States.
        We choose providers with strong security practices, but we can&apos;t control their systems
        directly.
      </p>

      <h2>How long we keep it</h2>
      <p>
        Booking, payment and invoice records are kept for at least five years because tax law
        requires it. Contact details and notes are kept while you remain a client. Ask us to delete
        your information and we will delete or de-identify whatever we are not required to keep.
      </p>

      <h2>Your rights</h2>
      <p>
        You can ask to see the information we hold about you, correct it, or have it deleted. Use
        the <a href="/contact">contact form</a> (choose &ldquo;Privacy request&rdquo;) or email{" "}
        <a href={`mailto:${SITE.privacyEmail}`}>{SITE.privacyEmail}</a>. We will reply within 30
        days. If you are unhappy with how we handled a request, tell us first. You can also complain
        to the Office of the Australian Information Commissioner at{" "}
        <a href="https://www.oaic.gov.au">oaic.gov.au</a>.
      </p>

      <h2>Messages and marketing</h2>
      <p>
        Booking confirmations and reminders are service messages. Marketing is sent only with your
        consent and always includes a way to opt out. See the{" "}
        <a href="/messaging">messaging policy</a>.
      </p>

      <h2>Children</h2>
      <p>
        If you are booking for someone under 18, please book on their behalf as their parent or
        guardian.
      </p>

      <h2>Security</h2>
      <p>
        We protect your information with the measures described on the{" "}
        <a href="/security">security page</a>.
      </p>

      <h2>Changes</h2>
      <p>If we change this policy we will update the date at the top of this page.</p>
    </LegalPage>
  );
}
