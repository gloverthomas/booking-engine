import type { ReactNode } from "react";
import { DARK_CSS, fonts, light } from "./theme";

interface LayoutProps {
  /** Inbox preview text. */
  preview: string;
  businessName: string;
  title: string;
  children: ReactNode;
}

const hiddenPreview = {
  display: "none",
  overflow: "hidden",
  maxHeight: 0,
  maxWidth: 0,
  opacity: 0,
  lineHeight: "1px",
} as const;

/** Table-based, inline-styled shell: the only thing every mail client agrees on. */
export function Layout({ preview, businessName, title, children }: LayoutProps) {
  return (
    <html lang="en-AU">
      {/* Email HTML, not a Next page: next/head does not apply. */}
      {/* eslint-disable-next-line @next/next/no-head-element */}
      <head>
        <meta httpEquiv="Content-Type" content="text/html; charset=UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="color-scheme" content="light dark" />
        <meta name="supported-color-schemes" content="light dark" />
        <title>{title}</title>
        <style dangerouslySetInnerHTML={{ __html: DARK_CSS }} />
      </head>
      <body
        className="bg-page"
        style={{ margin: 0, padding: 0, backgroundColor: light.page, fontFamily: fonts.body }}
      >
        <div style={hiddenPreview}>{preview}</div>
        <table
          role="presentation"
          width="100%"
          cellPadding={0}
          cellSpacing={0}
          className="bg-page"
          style={{ backgroundColor: light.page }}
        >
          <tbody>
            <tr>
              <td align="center" style={{ padding: "24px 12px" }}>
                <table
                  role="presentation"
                  width="100%"
                  cellPadding={0}
                  cellSpacing={0}
                  style={{ maxWidth: 560 }}
                >
                  <tbody>
                    <tr>
                      <td
                        className="bg-band"
                        style={{ backgroundColor: light.band, padding: "20px 28px" }}
                      >
                        <span
                          style={{
                            color: light.bandText,
                            fontFamily: fonts.heading,
                            fontWeight: 900,
                            fontSize: 15,
                            letterSpacing: "2px",
                            textTransform: "uppercase",
                          }}
                        >
                          {businessName}
                        </span>
                      </td>
                    </tr>
                    <tr>
                      <td
                        className="bg-card text-main"
                        style={{
                          backgroundColor: light.card,
                          color: light.text,
                          padding: "32px 28px 36px",
                        }}
                      >
                        {children}
                      </td>
                    </tr>
                    <tr>
                      <td
                        className="text-muted"
                        style={{
                          color: light.muted,
                          fontSize: 12,
                          lineHeight: "18px",
                          padding: "16px 28px 0",
                          textAlign: "center",
                        }}
                      >
                        {businessName}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </td>
            </tr>
          </tbody>
        </table>
      </body>
    </html>
  );
}
