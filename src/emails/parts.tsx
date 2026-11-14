import type { ReactNode } from "react";
import { fonts, light } from "./theme";

export function Heading({ children }: { children: ReactNode }) {
  return (
    <h1
      className="text-main"
      style={{
        margin: "0 0 20px",
        color: light.text,
        fontFamily: fonts.heading,
        fontWeight: 900,
        fontSize: 34,
        lineHeight: "38px",
        letterSpacing: "-0.5px",
        textTransform: "uppercase",
      }}
    >
      {children}
    </h1>
  );
}

export function Paragraph({ children, muted }: { children: ReactNode; muted?: boolean }) {
  return (
    <p
      className={muted ? "text-muted" : "text-main"}
      style={{
        margin: "0 0 16px",
        color: muted ? light.muted : light.text,
        fontSize: muted ? 13 : 16,
        lineHeight: muted ? "20px" : "24px",
      }}
    >
      {children}
    </p>
  );
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div
      className="text-muted"
      style={{
        margin: "24px 0 6px",
        color: light.muted,
        fontFamily: fonts.heading,
        fontWeight: 900,
        fontSize: 11,
        letterSpacing: "1.5px",
        textTransform: "uppercase",
      }}
    >
      {children}
    </div>
  );
}

/** Label / value pair stacked in one cell. Empty values render nothing. */
export function Detail({ label, children }: { label: string; children?: ReactNode }) {
  if (!children) return null;
  return (
    <>
      <SectionLabel>{label}</SectionLabel>
      <div className="text-main" style={{ color: light.text, fontSize: 16, lineHeight: "24px" }}>
        {children}
      </div>
    </>
  );
}

export interface PriceLine {
  label: string;
  value: string;
  strong?: boolean;
}

export function PriceTable({ lines }: { lines: PriceLine[] }) {
  return (
    <table role="presentation" width="100%" cellPadding={0} cellSpacing={0}>
      <tbody>
        {lines.map((line, index) => (
          <tr key={`${line.label}-${index}`}>
            <td
              className="text-main border-rule"
              style={{
                padding: "8px 0",
                borderTop: line.strong ? `2px solid ${light.text}` : `1px solid ${light.rule}`,
                color: light.text,
                fontSize: 15,
                fontWeight: line.strong ? 700 : 400,
              }}
            >
              {line.label}
            </td>
            <td
              align="right"
              className="text-main border-rule"
              style={{
                padding: "8px 0",
                borderTop: line.strong ? `2px solid ${light.text}` : `1px solid ${light.rule}`,
                color: light.text,
                fontSize: 15,
                fontWeight: line.strong ? 700 : 400,
                whiteSpace: "nowrap",
              }}
            >
              {line.value}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function Button({ href, children }: { href: string; children: ReactNode }) {
  return (
    <table role="presentation" cellPadding={0} cellSpacing={0} style={{ margin: "28px 0 8px" }}>
      <tbody>
        <tr>
          <td className="bg-button" style={{ backgroundColor: light.buttonBg }}>
            <a
              href={href}
              className="text-button"
              style={{
                display: "inline-block",
                padding: "15px 28px",
                color: light.buttonText,
                fontFamily: fonts.heading,
                fontWeight: 900,
                fontSize: 14,
                letterSpacing: "1px",
                textDecoration: "none",
                textTransform: "uppercase",
              }}
            >
              {children}
            </a>
          </td>
        </tr>
      </tbody>
    </table>
  );
}

export function Notice({ children }: { children: ReactNode }) {
  return (
    <div
      className="bg-notice text-main"
      style={{
        margin: "20px 0 0",
        padding: "14px 16px",
        backgroundColor: light.noticeBg,
        color: light.text,
        fontSize: 14,
        lineHeight: "21px",
      }}
    >
      {children}
    </div>
  );
}
