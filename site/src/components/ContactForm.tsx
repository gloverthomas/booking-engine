"use client";

import Script from "next/script";
import { useEffect, useRef, useState, type FormEvent } from "react";

type State =
  { kind: "idle" } | { kind: "sending" } | { kind: "sent" } | { kind: "error"; message: string };

const SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;

declare global {
  interface Window {
    hairmateTurnstile?: (token: string) => void;
  }
}

export function ContactForm() {
  const [state, setState] = useState<State>({ kind: "idle" });
  const token = useRef<string>("");

  useEffect(() => {
    window.hairmateTurnstile = (value) => {
      token.current = value;
    };
    return () => {
      delete window.hairmateTurnstile;
    };
  }, []);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setState({ kind: "sending" });
    try {
      const response = await fetch("/api/contact", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: data.get("name"),
          email: data.get("email"),
          topic: data.get("topic"),
          message: data.get("message"),
          website: data.get("website"),
          turnstileToken: token.current || undefined,
        }),
      });
      const result = (await response.json()) as { success: boolean; error?: string };
      if (result.success) {
        form.reset();
        setState({ kind: "sent" });
      } else {
        setState({ kind: "error", message: result.error ?? "Something went wrong." });
      }
    } catch {
      setState({ kind: "error", message: "We couldn't reach the server. Please try again." });
    }
  }

  if (state.kind === "sent") {
    return (
      <p className="status" role="status">
        <strong>Thanks, message sent.</strong> A person will reply by email.
      </p>
    );
  }

  return (
    <form className="form" onSubmit={onSubmit} noValidate={false}>
      <div className="field">
        <label htmlFor="name">Name</label>
        <input id="name" name="name" autoComplete="name" required maxLength={100} />
      </div>
      <div className="field">
        <label htmlFor="email">Email</label>
        <input id="email" name="email" type="email" autoComplete="email" required maxLength={200} />
      </div>
      <div className="field">
        <label htmlFor="topic">Topic</label>
        <select id="topic" name="topic" defaultValue="general">
          <option value="general">General question</option>
          <option value="support">Support</option>
          <option value="privacy">Privacy request (access, correction, deletion)</option>
          <option value="other">Other</option>
        </select>
      </div>
      <div className="field">
        <label htmlFor="message">Message</label>
        <textarea id="message" name="message" required minLength={10} maxLength={4000} />
      </div>
      <div className="field--trap" aria-hidden="true">
        <label htmlFor="website">Leave this empty</label>
        <input id="website" name="website" tabIndex={-1} autoComplete="off" />
      </div>
      {SITE_KEY ? (
        <>
          <Script
            src="https://challenges.cloudflare.com/turnstile/v0/api.js"
            strategy="lazyOnload"
          />
          <div className="cf-turnstile" data-sitekey={SITE_KEY} data-callback="hairmateTurnstile" />
        </>
      ) : null}
      <div>
        <button className="btn btn--ink" type="submit" disabled={state.kind === "sending"}>
          {state.kind === "sending" ? "Sending…" : "Send message"}
        </button>
      </div>
      <p className="muted" style={{ margin: 0, fontSize: "0.9rem" }}>
        We use your details only to reply. See the <a href="/privacy">privacy policy</a>.
      </p>
      <div aria-live="polite">
        {state.kind === "error" ? (
          <p className="status status--error" role="alert">
            {state.message}
          </p>
        ) : null}
      </div>
    </form>
  );
}
