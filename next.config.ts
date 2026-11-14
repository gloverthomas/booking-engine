import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs/config";
import { publicFrameHeaders } from "./src/lib/public-api-frame";

/** Admin screens must never be framed. */
const ADMIN_PATHS = [
  "/login",
  "/calendar/:path*",
  "/bookings/:path*",
  "/clients/:path*",
  "/checkout/:path*",
  "/catalog/:path*",
  "/hours/:path*",
  "/reports/:path*",
  "/integrations/:path*",
  "/settings/:path*",
];

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  async redirects() {
    // The public site embeds /book; the bare domain just goes there.
    return [{ source: "/", destination: "/book", permanent: false }];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
        ],
      },
      // Public booking pages may be framed by the business's own site (PUBLIC_EMBED_ORIGINS) only.
      ...publicFrameHeaders(process.env.PUBLIC_EMBED_ORIGINS),
      ...ADMIN_PATHS.map((source) => ({
        source,
        headers: [{ key: "Content-Security-Policy", value: "frame-ancestors 'none'" }],
      })),
      // The service worker must always be revalidated so updates reach installed copies.
      {
        source: "/sw.js",
        headers: [{ key: "Cache-Control", value: "no-cache, max-age=0, must-revalidate" }],
      },
    ];
  },
};

// Source maps are only uploaded when SENTRY_AUTH_TOKEN is set (a build-time secret on the host).
export default withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  silent: !process.env.CI,
  telemetry: false,
  sourcemaps: { disable: !process.env.SENTRY_AUTH_TOKEN },
});
