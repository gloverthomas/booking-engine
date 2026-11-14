# HairMate site (hairmate.shop)

The marketing site, legal pages and contact form. A separate project from the booking app in the repo
root, with its own dependencies and its own deploy, so a change here can never affect bookings.

| Page                                              | Path                                         |
| ------------------------------------------------- | -------------------------------------------- |
| Landing                                           | `/`                                          |
| Contact (form)                                    | `/contact`                                   |
| Privacy policy, Terms, Messaging policy, Security | `/privacy` `/terms` `/messaging` `/security` |

## Develop

```bash
cd site
pnpm install
cp .env.example .env.local
pnpm dev          # http://localhost:3100
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

## Before it goes public

1. **Fill in the operator details** (`ENTITY_LEGAL_NAME`, `ENTITY_ABN`, `ENTITY_TRADING_NAME`, `ENTITY_ADDRESS`).
   Until all four are set, the pages say "to be confirmed", show a "Draft" notice, and the site tells search
   engines not to index it (`robots` and the `noindex` meta tag).
2. **Contact form:** set `RESEND_API_KEY`, `CONTACT_FROM_EMAIL` (a verified sending address) and
   `CONTACT_TO_EMAIL`. Without them the form politely asks people to email `hello@hairmate.shop`.
   Optionally add Cloudflare Turnstile keys.
3. **Mailboxes:** `hello@` and `privacy@` on the domain must exist (for example Cloudflare Email Routing
   forwarding to a real inbox).
4. **Legal review:** the policies describe what the booking app actually does with data, but they are
   drafts. Have them reviewed before relying on them, and update them whenever providers or data flows
   change (also bump `LEGAL_UPDATED` in `src/lib/entity.ts`).
5. **Claims:** the feature list only says "Built" for things that exist in the app. Keep it honest.

## Deploy (Railway)

A separate service from the same repo: **Root directory** `site`, build `pnpm build`, start
`pnpm start`. Point `hairmate.shop` at it. The booking app runs separately at `app.hairmate.shop`.
