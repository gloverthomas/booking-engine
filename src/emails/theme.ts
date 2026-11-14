/**
 * Brand tokens for email. Email clients do not support CSS variables reliably, so these are
 * literal values that components inline; the dark palette is applied through a media query
 * (Apple Mail, Outlook.com, iOS) and Gmail's own inversion is tolerated by keeping a black band
 * and a peach accent that read well either way.
 */
export const light = {
  page: "#F8D9C2",
  card: "#FFF8F2",
  text: "#111111",
  muted: "#5B4A3F",
  rule: "#EBCDB6",
  band: "#111111",
  bandText: "#F8D9C2",
  buttonBg: "#111111",
  buttonText: "#F8D9C2",
  noticeBg: "#F8D9C2",
} as const;

export const dark = {
  page: "#0E0D0C",
  card: "#1B1917",
  text: "#F6EDE6",
  muted: "#BBAB9E",
  rule: "#3A332D",
  band: "#000000",
  bandText: "#F8D9C2",
  buttonBg: "#F4B58A",
  buttonText: "#111111",
  noticeBg: "#2A231E",
} as const;

export const fonts = {
  heading: "'Arial Black', 'Helvetica Neue', Helvetica, Arial, sans-serif",
  body: "'Helvetica Neue', Helvetica, Arial, sans-serif",
} as const;

/** Class names the dark-mode stylesheet targets. */
export const DARK_CSS = `
@media (prefers-color-scheme: dark) {
  .bg-page { background-color: ${dark.page} !important; }
  .bg-card { background-color: ${dark.card} !important; }
  .bg-band { background-color: ${dark.band} !important; }
  .bg-notice { background-color: ${dark.noticeBg} !important; }
  .bg-button { background-color: ${dark.buttonBg} !important; }
  .text-main { color: ${dark.text} !important; }
  .text-muted { color: ${dark.muted} !important; }
  .text-button { color: ${dark.buttonText} !important; }
  .border-rule { border-color: ${dark.rule} !important; }
}
[data-ogsc] .text-main { color: ${dark.text} !important; }
[data-ogsb] .bg-card { background-color: ${dark.card} !important; }
`;
