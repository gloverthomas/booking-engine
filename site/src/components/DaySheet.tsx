/** The hero visual: one day in the book. Blocks fill in as they are booked. Purely decorative. */

interface Block {
  /** Start, in 15-minute units after 9:00. */
  at: number;
  /** Length in 15-minute units. */
  len: number;
  kind: "booked" | "held" | "busy";
  title: string;
  note: string;
}

const BLOCKS: Block[] = [
  { at: 0, len: 3, kind: "booked", title: "Maintenance Haircut", note: "9:00 · deposit paid" },
  { at: 6, len: 4, kind: "held", title: "Held for payment", note: "10:30 · 10 min hold" },
  { at: 12, len: 4, kind: "busy", title: "Dentist", note: "12:00 · from Google Calendar" },
  { at: 22, len: 3, kind: "booked", title: "Maintenance Haircut", note: "2:30 · deposit paid" },
  { at: 28, len: 4, kind: "booked", title: "Restructure / Restyle", note: "4:00 · deposit paid" },
];

const HOURS = ["9", "10", "11", "12", "1", "2", "3", "4"];

export function DaySheet() {
  return (
    <figure
      className="sheet"
      aria-label="Illustration: a day of appointments filling a calendar"
      style={{ margin: 0 }}
    >
      <div className="sheet__head" aria-hidden="true">
        <span>Sat 21 Nov</span>
        <span>Northside</span>
      </div>
      <div className="sheet__body" aria-hidden="true">
        <div className="sheet__times">
          {HOURS.map((h) => (
            <span key={h}>{h}:00</span>
          ))}
        </div>
        <div className="sheet__grid">
          {BLOCKS.map((b, i) => (
            <div
              key={b.at}
              className={`block block--${b.kind}`}
              style={{ "--at": b.at, "--len": b.len, "--i": i } as React.CSSProperties}
            >
              {b.title}
              <small>{b.note}</small>
            </div>
          ))}
        </div>
      </div>
      <p className="sheet__toast" aria-hidden="true">
        <span className="tick">✓</span>
        <span>
          <b>Booking confirmed.</b> Maintenance Haircut, 2:30pm. Deposit $47.50 paid. Email and SMS
          sent.
        </span>
      </p>
    </figure>
  );
}
