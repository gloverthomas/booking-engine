import {
  CalendarClock,
  CalendarDays,
  ChartColumn,
  ClipboardList,
  Hourglass,
  IdCard,
  Plug,
  Scissors,
  Settings,
  Timer,
  Users,
  UsersRound,
  type LucideIcon,
  type LucideProps,
} from "lucide-react";
import type { NavIcon } from "./nav-config";

const icons: Record<NavIcon, LucideIcon> = {
  calendar: CalendarDays,
  bookings: ClipboardList,
  clients: Users,
  waitlist: Hourglass,
  roster: CalendarClock,
  timesheets: Timer,
  team: UsersRound,
  reports: ChartColumn,
  catalog: Scissors,
  staff: IdCard,
  integrations: Plug,
  settings: Settings,
};

export function NavGlyph({ icon, ...props }: { icon: NavIcon } & LucideProps) {
  const Icon = icons[icon];
  return <Icon aria-hidden {...props} />;
}
