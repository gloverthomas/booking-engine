import type { MetadataRoute } from "next";
import { SITE, entityConfigured, readEntity } from "@/lib/entity";

export default function robots(): MetadataRoute.Robots {
  if (!entityConfigured(readEntity())) return { rules: { userAgent: "*", disallow: "/" } };
  return { rules: { userAgent: "*", allow: "/" }, sitemap: `${SITE.url}/sitemap.xml` };
}
