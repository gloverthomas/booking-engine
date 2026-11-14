import Link from "next/link";

export default function NotFound() {
  return (
    <div className="wrap legal">
      <p className="eyebrow">404</p>
      <h1 className="display">Not booked.</h1>
      <p className="lede">That page doesn&apos;t exist.</p>
      <p style={{ marginTop: "2rem" }}>
        <Link className="btn btn--ink" href="/">
          Back to the front
        </Link>
      </p>
    </div>
  );
}
