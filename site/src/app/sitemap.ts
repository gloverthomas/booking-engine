import type { MetadataRoute } from "next";
import { SITE } from "@/lib/entity";

export default function sitemap(): MetadataRoute.Sitemap {
  return ["", "/contact", "/privacy", "/terms", "/messaging", "/security"].map((path) => ({
    url: `${SITE.url}${path}`,
  }));
}
