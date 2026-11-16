import type { Metadata } from "next";
import { LegalPage, Operator } from "@/components/LegalPage";
import { SITE } from "@/lib/entity";

export const metadata: Metadata = { title: "Terms of use" };

export default function TermsPage() {
  return (
    <LegalPage
      title="Terms of use"
      intro="The rules for using this website and the online booking page."
    >
      <h2>About these terms</h2>
      <p>
        This website and the online booking page are provided by <Operator />. By using them you
        agree to these terms. If you do not agree, please do not use them.
      </p>

      <h2>Making a booking</h2>
      <ul>
        <li>Give accurate details so we can contact you about your appointment.</li>
        <li>You must be 18 or older, or book for a child as their parent or guardian.</li>
        <li>
          Your booking is an agreement between you and the salon you book with for the services
          you chose, at the price shown.
        </li>
        <li>
          Your slot is held for a short time while you pay. If the hold runs out, the slot is
          released.
        </li>
      </ul>

      <h2>Deposits, cancellations and fees</h2>
      <p>
        The deposit and cancellation rules are shown on the booking page before you pay, and you
        must accept them to book. In summary: the deposit is deducted from the price of your
        service; changes and cancellations need the notice period shown; inside that period the
        deposit is forfeited; and a fee stated in the policy may be charged to the card you booked
        with if you do not attend. We keep a record of when you accepted the policy.
      </p>
      <p>
        Nothing in these terms limits your rights under the Australian Consumer Law, including any
        right to a remedy if a service is not provided with due care and skill.
      </p>

      <h2>Using the website</h2>
      <ul>
        <li>
          Don&apos;t attempt to disrupt the service, probe it for weaknesses, or use it to send
          spam.
        </li>
        <li>Don&apos;t use automated tools to make bookings or submit forms.</li>
        <li>We may block access to anyone who breaks these rules.</li>
      </ul>

      <h2>Availability</h2>
      <p>
        We aim to keep the booking page available but do not promise it will always work. If
        something goes wrong, contact the salon and we will sort out your appointment.
      </p>

      <h2>Liability</h2>
      <p>
        To the extent the law allows, we are not liable for indirect or consequential loss arising
        from your use of the website or the booking page. This does not affect any right you have
        that cannot be excluded by law.
      </p>

      <h2>Privacy and messages</h2>
      <p>
        How we handle your information is set out in the <a href="/privacy">privacy policy</a> and
        the <a href="/messaging">messaging policy</a>.
      </p>

      <h2>Governing law</h2>
      <p>These terms are governed by the laws of Victoria, Australia.</p>

      <h2>Contact</h2>
      <p>
        <a href={`mailto:${SITE.supportEmail}`}>{SITE.supportEmail}</a>
      </p>
    </LegalPage>
  );
}
