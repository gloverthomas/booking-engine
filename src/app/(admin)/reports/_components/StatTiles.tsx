export interface Tile {
  label: string;
  value: string;
  /** A short line under the value: context, never a second headline. */
  note?: string;
  /** The one number the page leads with. */
  lead?: boolean;
}

/** Summary tiles. A definition list, so label/value pairs are announced together by screen readers. */
export function StatTiles({ tiles }: { tiles: Tile[] }) {
  return (
    <dl className="rpt-tiles">
      {tiles.map((tile) => (
        <div key={tile.label} className="rpt-tile" data-lead={tile.lead ? "true" : undefined}>
          <dt>{tile.label}</dt>
          <dd>
            <span className="rpt-tile-value">{tile.value}</span>
            {tile.note ? <span className="rpt-tile-note">{tile.note}</span> : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}
