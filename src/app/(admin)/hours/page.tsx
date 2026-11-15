import { redirect } from "next/navigation";

/** Hours became the Roster: weekly hours, day exceptions and time off all live there now. */
export default function HoursRedirect(): never {
  redirect("/roster");
}
