import Link from "next/link";
import { DaySheet } from "./DaySheet";

export function Hero() {
  return (
    <section className="hero" aria-labelledby="hero-title">
      <div className="wrap hero__grid">
        <div>
          <p className="eyebrow">Booking software for hair salons</p>
          <h1 id="hero-title" className="display">
            Book.
            <br />
            Remind.
            <br />
            Get <span className="stamp">paid.</span>
          </h1>
          <p className="lede">
            Clients book themselves, pay a deposit up front and get reminded the day before, so your
            chair stays full and your phone stays quiet. Your calendar, your payments and your
            accounts keep up on their own.
          </p>
          <div className="hero__cta">
            <Link className="btn btn--ink" href="/contact">
              Talk to us
            </Link>
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

const FEATURES: Array<{ title: string; body: string }> = [
  {
    title: "Fill the chair around the clock",
    body: "Clients choose a service, a stylist and a time whenever it suits them, on a page that matches your website and embeds anywhere. Fewer calls and DMs, more full days.",
  },
  {
    title: "Get paid before they arrive",
    body: "A deposit (50% by default) is taken by card or Apple Pay when they book, and the card is saved in case a fee applies. The slot is held for ten minutes while they pay.",
  },
  {
    title: "No-shows stop costing you",
    body: "Your cancellation rules apply themselves. Changes inside the window keep the deposit, and an optional no-show fee is charged to the saved card. No awkward conversations.",
  },
  {
    title: "Clients who actually turn up",
    body: "A confirmation with a calendar file, then an SMS or email reminder the day before. The reminder checks the booking is still on before it sends.",
  },
  {
    title: "One calendar for the whole team",
    body: "Each stylist has their own column, roster and timesheet. Owners see everything; stylists see their own day. Drag a booking to move it, from any phone.",
  },
  {
    title: "Never double-booked",
    body: "Syncs both ways with Google Calendar. Bookings appear in your own calendar, and personal events block the times they cover.",
  },
  {
    title: "Fill the gaps",
    body: "When a day is full, clients join a waitlist. When a time opens up, offer it to someone who wants it in a tap.",
  },
  {
    title: "The books look after themselves",
    body: "Each booking creates the contact, the invoice and the payments in Xero, with the PDF emailed to the client. Nothing to retype at month end.",
  },
  {
    title: "Know your numbers",
    body: "Client history and notes, VIP and blocked flags, duplicate merging. Revenue, utilisation, cancellations and rebooking, with CSV export.",
  },
  {
    title: "Switch without starting over",
    body: "Bring your clients and booked appointments across from a spreadsheet export. You see a dry run first, and nobody is messaged about appointments they already have.",
  },
];

export function Features() {
  return (
    <section id="features" className="section" aria-labelledby="features-title">
      <div className="wrap split">
        <div className="split__sticky">
          <p className="eyebrow">What it does for you</p>
          <h2 id="features-title" className="display h2">
            Everything the chair needs.
          </h2>
          <p className="lede">
            Less time on admin, fewer gaps in the day and money in the bank before the appointment.
          </p>
        </div>
        <ol className="ledger">
          {FEATURES.map((f, i) => (
            <li key={f.title}>
              <span className="ledger__no">{String(i + 1).padStart(2, "0")}</span>
              <div>
                <h3>{f.title}</h3>
                <p>{f.body}</p>
              </div>
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
            Connect HairMate to Claude and run the salon in plain English, between clients and
            without opening a screen. Looking things up is instant. Every change shows a preview and
            waits for your yes. Refunds and fee charges are switched off unless you turn them on.
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
        <p className="eyebrow">Get started</p>
        <h2 id="cta-title" className="display h2">
          Want HairMate for your salon?
        </h2>
        <p className="lede">
          Tell us about your salon and we will show you around. A person will reply.
        </p>
        <div className="hero__cta">
          <Link
            className="btn btn--ink"
            href="/contact"
            style={{ background: "var(--paper)", color: "var(--ink)", borderColor: "var(--paper)" }}
          >
            Get in touch
          </Link>
        </div>
      </div>
    </section>
  );
}
