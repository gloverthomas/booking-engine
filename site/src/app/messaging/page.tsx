import type { Metadata } from "next";
import { LegalPage, Operator } from "@/components/LegalPage";
import { SITE } from "@/lib/entity";

export const metadata: Metadata = { title: "Messaging policy" };

export default function MessagingPage() {
  return (
    <LegalPage
      title="Messaging policy"
      intro="The text messages and emails HairMate sends, why, and how to stop the ones you can."
    >
      <h2>Who sends them</h2>
      <p>
        Messages are sent on behalf of the salon you booked with by <Operator />, using the HairMate
        booking system. Text messages show the salon&apos;s name or a mobile number as the sender.
      </p>

      <h2>What we send</h2>
      <ul>
        <li>
          <strong>Service messages</strong>, sent because of a booking you made: a confirmation, a
          reminder the day before, a notice if the appointment is moved or cancelled, and a notice
          if a fee is charged. Expect about two per booking, more if you change it.
        </li>
        <li>
          <strong>Marketing messages</strong>, only if you ticked the box when booking. Every one
          includes a way to opt out. We do not send marketing to anyone who has not agreed.
        </li>
      </ul>

      <h2>Where they go</h2>
      <p>
        To the mobile number and email address you gave when booking. Standard carrier rates for
        text messages from your plan may apply. We do not sell or share your number for anyone
        else&apos;s marketing.
      </p>

      <h2>How to stop</h2>
      <p>
        For marketing, use the opt-out in the message or tell us. To stop reminders, or if a message
        reached you by mistake, email{" "}
        <a href={`mailto:${SITE.supportEmail}`}>{SITE.supportEmail}</a> or use the{" "}
        <a href="/contact">contact form</a>, or tell the salon. We will stop the reminders; you will
        still get messages that are needed to manage a booking you have made.
      </p>

      <h2>The rules we follow</h2>
      <p>
        We follow the Spam Act 2003 (consent, identification and opt-out) and the Australian
        Communications and Media Authority&apos;s rules for SMS sender names.
      </p>

      <h2>Your information</h2>
      <p>
        We keep a record of the messages we send. See the <a href="/privacy">privacy policy</a> for
        how your information is handled.
      </p>
    </LegalPage>
  );
}
