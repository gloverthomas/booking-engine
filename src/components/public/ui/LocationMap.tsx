import type { CatalogLocation } from "@/lib/public-api-types";
import { mapQuery, mapsDirectionsUrl, mapsEmbedUrl, mapsSearchUrl } from "../flow/maps";

const EMBED_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_EMBED_KEY;

interface LocationMapProps {
  location: CatalogLocation;
}

/**
 * A map of the chosen location with "Open in Maps" and "Directions" links. The embedded map needs a
 * Google Maps Embed API key (NEXT_PUBLIC_GOOGLE_MAPS_EMBED_KEY); without one only the links show.
 */
export function LocationMap({ location }: LocationMapProps) {
  const query = mapQuery(location);
  if (!query) return null;
  const embed = mapsEmbedUrl(query, EMBED_KEY);

  return (
    <div className="rk-map" role="group" aria-label={`Map of ${location.name}`}>
      {embed ? (
        <iframe
          className="rk-map__frame"
          title={`Map showing ${location.name}`}
          src={embed}
          loading="lazy"
          referrerPolicy="no-referrer-when-downgrade"
          allowFullScreen
        />
      ) : null}
      <div className="rk-map__bar">
        <span className="rk-map__address">{query.replace(/, Australia$/, "")}</span>
        <span className="rk-map__links">
          <a href={mapsSearchUrl(query)} target="_blank" rel="noopener noreferrer">
            Open in Maps
          </a>
          <a href={mapsDirectionsUrl(query)} target="_blank" rel="noopener noreferrer">
            Directions
          </a>
        </span>
      </div>
      {location.arrivalNote ? <p className="rk-map__note">{location.arrivalNote}</p> : null}
    </div>
  );
}
