import { Detail, PriceTable, SectionLabel } from "./parts";
import type { PriceLineProp } from "./props";

interface Props {
  dateLabel: string;
  timeLabel: string;
  services: PriceLineProp[];
  locationName?: string;
  address?: string;
  arrivalNote?: string;
}

/** When, what and where. Shared by the confirmation and moved emails. */
export function AppointmentDetails({
  dateLabel,
  timeLabel,
  services,
  locationName,
  address,
  arrivalNote,
}: Props) {
  return (
    <>
      <Detail label="When">
        {dateLabel}
        <br />
        {timeLabel}
      </Detail>
      {locationName ? (
        <Detail label="Where">
          <strong>{locationName}</strong>
          {address ? (
            <>
              <br />
              {address}
            </>
          ) : null}
          {arrivalNote ? (
            <>
              <br />
              <em>{arrivalNote}</em>
            </>
          ) : null}
        </Detail>
      ) : null}
      <SectionLabel>Services</SectionLabel>
      <PriceTable lines={services.map((s) => ({ label: s.name, value: s.price }))} />
    </>
  );
}
