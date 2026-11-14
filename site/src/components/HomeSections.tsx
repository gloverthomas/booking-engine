import Link from "next/link";
import { DaySheet } from "./DaySheet";
import { SITE } from "@/lib/entity";

export function Hero() {
  return (
    <section className="hero" aria-labelledby="hero-title">
      <div className="wrap hero__grid">
        <div>
          <p className="eyebrow">Booking software · Ryan Kennedy Hairdressing</p>
          <h1 id="hero-title" className="display">
            Book.
            <br />
            Remind.
            <br />
            Get <span className="stamp">paid.</span>
          </h1>
          <p className="lede">
            HairMate is the booking system built for Ryan Kennedy Hairdressing: online booking,
            deposits taken up front, SMS reminders, a calendar that syncs with Google, and invoices
            that land in Xero.
          </p>
          <div className="hero__cta">
            <a className="btn btn--ink" href={`${SITE.appUrl}/book`}>
              Book an appointment
            </a>
            <Link className="btn btn--ghost" href="#features">
              See what it does
            </Link>
          </div>
        </div>
        <DaySheet />
      </div>
    </section>
  );
}

const FEATURES: Array<{ title: string; body: string; status: "built" | "next" }> = [
  {
    title: "Online booking, 24/7",
    body: "Clients pick a location, services and a time on a page that matches the salon's site. It embeds on any website.",
    status: "built",
  },
  {
    title: "Deposits at booking",
    body: "A deposit (50% by default) is taken by card or Apple Pay through Stripe, and the card is saved for fees. The slot is held for ten minutes while they pay.",
    status: "built",
  },
  {
    title: "Cancellation rules that apply themselves",
    body: "Changes outside the window are free. Inside it, the deposit is kept, with an optional extra fee for a no-show charged to the saved card.",
    status: "built",
  },
  {
    title: "SMS and email reminders",
    body: "A confirmation with a calendar file, and a reminder the day before. The reminder checks the booking is still on before it sends.",
    status: "built",
  },
  {
    title: "A calendar that lives on your phone",
    body: "Day, three-day and week views. Drag a booking to move it. Install it to the home screen and it opens like an app.",
    status: "built",
  },
  {
    title: "Google Calendar, both ways",
    body: "Bookings appear in your own calendar, and personal events block the times they cover, so nobody books over the dentist.",
    status: "built",
  },
  {
    title: "Xero, automatically",
    body: "Each booking creates the contact, the invoice and the payments in Xero, with the PDF emailed to the client.",
    status: "built",
  },
  {
    title: "Clients, notes and reports",
    body: "History, notes, VIP and blocked flags, duplicate merging. Revenue, utilisation, cancellations and rebooking, with CSV export.",
    status: "built",
  },
];

export function Features() {
  return (
    <section id="features" className="section" aria-labelledby="features-title">
      <div className="wrap split">
        <div className="split__sticky">
          <p className="eyebrow">What it does</p>
          <h2 id="features-title" className="display h2">
            Everything the chair needs.
          </h2>
          <p className="lede">Built from how a working hairdresser actually runs a day.</p>
        </div>
        <ol className="ledger">
          {FEATURES.map((f, i) => (
            <li key={f.title}>
              <span className="ledger__no">{String(i + 1).padStart(2, "0")}</span>
              <div>
                <h3>{f.title}</h3>
                <p>{f.body}</p>
              </div>
              <span className={`tag tag--${f.status}`}>
                {f.status === "built" ? "Built" : "Next"}
              </span>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

const STEPS = [
  ["Choose", "Location, services and a time, on any phone."],
  ["Deposit", "Card or Apple Pay. The slot is held while they pay."],
  ["Confirmed", "Email with a calendar file, an SMS, and a reminder the day before."],
  ["Appointment", "Check out with cash, EFTPOS or other. The balance is recorded."],
  ["The books", "Invoice and payments appear in Xero."],
] as const;

export function HowItWorks() {
  return (
    <section id="how" className="section" aria-labelledby="how-title">
      <div className="wrap">
        <p className="eyebrow">One booking, start to finish</p>
        <h2 id="how-title" className="display h2">
          From tap to tax invoice.
        </h2>
        <ol className="flow">
          {STEPS.map(([title, body]) => (
            <li key={title}>
              <h3>{title}</h3>
              <p>{body}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

export function Integrations() {
  return (
    <section className="section section--ink" aria-labelledby="int-title">
      <div className="wrap">
        <p className="eyebrow">Plays well with</p>
        <h2 id="int-title" className="display h2">
          Tools you already use.
        </h2>
        <ul className="logos">
          <li>Stripe</li>
          <li>Google Calendar</li>
          <li>Xero</li>
          <li>SMS</li>
          <li>Email</li>
        </ul>
        <p className="lede muted">
          Card payments are handled by Stripe, so card numbers never touch HairMate. Names are the
          property of their owners; HairMate is not endorsed by them.
        </p>
      </div>
    </section>
  );
}

const PROMPTS = [
  "Who's booked on Saturday?",
  "Block out next Friday afternoon.",
  "How did October compare to September?",
  "Move Sam to 3pm and let them know.",
];

export function ClaudeSection() {
  return (
    <section id="claude" className="section" aria-labelledby="claude-title">
      <div className="wrap split">
        <div className="split__sticky">
          <p className="eyebrow">Run it by asking</p>
          <h2 id="claude-title" className="display h2">
            Ask Claude.
          </h2>
          <p className="lede">
            Connect HairMate to Claude and manage the salon in plain English. Reads are instant.
            Every change shows a preview and waits for a yes. Refunds and fee charges are switched
            off unless you turn them on.
          </p>
        </div>
        <ul className="prompts" aria-label="Examples of what you can ask">
          {PROMPTS.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      </div>
    </section>
  );
}

const NEXT = [
  "Tap to Pay on iPhone",
  "More than one stylist: rosters and timesheets",
  "Waitlist for cancellations",
  "Packages and gift vouchers",
];

export function ComingNext() {
  return (
    <section className="section" aria-labelledby="next-title">
      <div className="wrap">
        <p className="eyebrow">Not yet, and we&apos;ll say so</p>
        <h2 id="next-title" className="display h2">
          Coming next.
        </h2>
        <ul className="next">
          {NEXT.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      </div>
    </section>
  );
}

export function Facts() {
  return (
    <section className="section" aria-labelledby="facts-title">
      <div className="wrap">
        <p className="eyebrow">Your clients&apos; details</p>
        <h2 id="facts-title" className="display h2">
          Used for bookings. Nothing else.
        </h2>
        <div className="facts">
          <div>
            <h3>No ads, no selling</h3>
            <p>
              Client details are used to run appointments. Marketing messages only go to people who
              tick a box.
            </p>
          </div>
          <div>
            <h3>Locked down</h3>
            <p>
              Sign-in is by Google, limited to approved email addresses. Connection tokens are
              encrypted, and every change is logged.
            </p>
          </div>
          <div>
            <h3>Plain English</h3>
            <p>
              Read the <Link href="/privacy">privacy policy</Link>, the{" "}
              <Link href="/messaging">messaging policy</Link> and the{" "}
              <Link href="/security">security page</Link>. They say what actually happens.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

export function ContactCta() {
  return (
    <section className="section section--ink" aria-labelledby="cta-title">
      <div className="wrap">
        <p className="eyebrow">Say hello</p>
        <h2 id="cta-title" className="display h2">
          Questions? Privacy request?
        </h2>
        <p className="lede">Write to us and a person will reply.</p>
        <div className="hero__cta">
          <Link
            className="btn btn--ink"
            href="/contact"
            style={{ background: "var(--paper)", color: "var(--ink)", borderColor: "var(--paper)" }}
          >
            Contact us
          </Link>
        </div>
      </div>
    </section>
  );
}
