import { Resend } from "resend";
import { handleContact, type ContactDeps } from "@/lib/contact";
import { createLimiter } from "@/lib/rate-limit";

const allow = createLimiter(5, 60 * 60 * 1000);

function clientIp(request: Request): string {
  // Railway appends the real client address last.
  const forwarded = request.headers.get("x-forwarded-for");
  return forwarded?.split(",").at(-1)?.trim() || "unknown";
}

async function verifyTurnstile(token: string, ip: string): Promise<boolean> {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) return false;
  const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body: new URLSearchParams({ secret, response: token, remoteip: ip }),
  });
  if (!response.ok) return false;
  const result = (await response.json()) as { success?: boolean };
  return result.success === true;
}

export async function POST(request: Request): Promise<Response> {
  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return Response.json({ success: false, error: "Invalid request." }, { status: 400 });
  }

  const apiKey = process.env.RESEND_API_KEY;
  const deps: ContactDeps = {
    allow,
    config: {
      to: apiKey ? process.env.CONTACT_TO_EMAIL : undefined,
      from: process.env.CONTACT_FROM_EMAIL,
    },
    verifyTurnstile: process.env.TURNSTILE_SECRET_KEY ? verifyTurnstile : undefined,
    log: (entry) => process.stdout.write(`${JSON.stringify({ service: "site", ...entry })}\n`),
    async send(message) {
      const resend = new Resend(apiKey);
      const { error } = await resend.emails.send({
        from: message.from,
        to: message.to,
        replyTo: message.replyTo,
        subject: message.subject,
        text: message.text,
      });
      if (error) throw new Error(error.message);
    },
  };

  const result = await handleContact(input, clientIp(request), deps);
  return Response.json(result.body, {
    status: result.status,
    headers: { "Cache-Control": "no-store" },
  });
}
