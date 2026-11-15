# Public booking flow (workstream B)

Pages: `/book`, `/book/confirmed/[token]`, `/manage/[token]`. API: `/api/public/*`.

## Environment

| Variable                             | Used by                   | Notes                                                                                  |
| ------------------------------------ | ------------------------- | -------------------------------------------------------------------------------------- |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | Pay step                  | Without it the pay step shows "online payment isn't available".                        |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY`     | Details step widget       | Without it no widget renders.                                                          |
| `TURNSTILE_SECRET_KEY`               | `POST /holds`             | Missing in development: check skipped. Missing in production: holds fail with 503.     |
| `ENCRYPTION_KEY`                     | manage links              | Same key the integrator uses for `makeManageToken`.                                    |
| `PUBLIC_EMBED_ORIGINS`               | `frame-ancestors` (below) | Comma-separated origins allowed to iframe the booking pages. Unset = same origin only. |
| `PUBLIC_TRUSTED_PROXY_HOPS`          | rate limiting             | Reverse proxies in front of the app (default 1). Used to read the client IP safely.    |

## Choosing a stylist and the waitlist

- `settings.chooseStaff` on: the catalog lists `staff` per location (active, works there, offers the
  service; price and time resolved through `priceFor` with the stylist override then their level price).
  A "Stylist" step appears after services when a location has two or more stylists. "Anyone available"
  is the default; availability slots then carry `staffId`, `priceCents` and `durationMin` for the
  stylist assigned to that time, and the hold is pinned to that stylist (`staffRequested: false`). Picking
  a person sends `staffId` with `staffRequested: true`. With the setting off nothing changes.
- `settings.waitlistEnabled` on: when a chosen day or the whole month has no times, the picker shows
  `<JoinWaitlistCta />` (owned by the waitlist workstream). Not shown when rescheduling.
- The manage page always reschedules within the booking's own stylist (`staffId` in the response).

## Embedding in an iframe

1. Set `PUBLIC_EMBED_ORIGINS=https://www.example.com` and wire the headers in `next.config.ts`:

   ```ts
   import { publicFrameHeaders } from "./src/lib/public-api-frame";
   // inside the config object:
   async headers() {
     return publicFrameHeaders(process.env.PUBLIC_EMBED_ORIGINS);
   },
   ```

   This sends `Content-Security-Policy: frame-ancestors 'self' <origins>` on `/book`, `/book/*` and
   `/manage/*` only. Admin routes keep their own policy.

2. On the host page:

   ```html
   <iframe
     id="rk-booking"
     src="https://book.example.com/book"
     title="Book an appointment"
     style="width:100%;border:0;min-height:600px"
     allow="payment"
   ></iframe>
   <script>
     window.addEventListener("message", function (e) {
       var d = e.data;
       if (!d || d.source !== "rk-booking") return;
       var f = document.getElementById("rk-booking");
       if (e.source !== f.contentWindow) return;
       if (d.type === "resize") f.style.height = d.height + "px";
       if (d.type === "scroll-top") f.scrollIntoView({ block: "start" });
     });
   </script>
   ```

   Messages: `{ source: "rk-booking", type: "resize", height }` and `{ source: "rk-booking", type: "scroll-top" }`.
   `allow="payment"` lets Apple Pay / Google Pay work inside the frame. While framed, the top bar is
   hidden and the layout is compact. Pages never use `100vh` heights, so auto-resize cannot feed back.

## Content-Security-Policy notes for the integrator

If a strict CSP is added, the public pages need: `script-src https://js.stripe.com https://challenges.cloudflare.com`,
`frame-src https://js.stripe.com https://hooks.stripe.com https://challenges.cloudflare.com`,
`connect-src https://api.stripe.com`, `style-src https://fonts.googleapis.com` (Stripe font) and
`img-src data:` (paper-grain texture is an inline SVG data URI).

## Design

Swiss poster on peach: one heavy variable grotesk (Archivo, 900, width 88%, uppercase, -0.045em) and DM Mono
for times and prices. Tokens live in `styles/tokens.css` (all palette, type, space and motion values).
Only `transform` and `opacity` animate; every animation is disabled under `prefers-reduced-motion`.
Text contrast on peach: ink 18:1, soft ink 7.5:1, signal text 5:1.
