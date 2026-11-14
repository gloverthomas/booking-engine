import { Layout } from "./Layout";
import { Paragraph } from "./parts";
import type { OneOffMessageProps } from "./props";

export function OneOffMessage({ businessName, subject, body }: OneOffMessageProps) {
  const paragraphs = body
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  return (
    <Layout title={subject} businessName={businessName} preview={paragraphs[0] ?? subject}>
      {paragraphs.map((paragraph, index) => (
        <Paragraph key={index}>
          {paragraph.split("\n").flatMap((line, i) => (i === 0 ? [line] : [<br key={i} />, line]))}
        </Paragraph>
      ))}
    </Layout>
  );
}
