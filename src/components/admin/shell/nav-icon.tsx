import {
  CalendarDays,
  ChartColumn,
  ClipboardList,
  Clock,
  Plug,
  Scissors,
  Settings,
  Users,
  type LucideIcon,
  type LucideProps,
} from "lucide-react";
import type { NavIcon } from "./nav-config";

const icons: Record<NavIcon, LucideIcon> = {
  calendar: CalendarDays,
  bookings: ClipboardList,
  clients: Users,
  catalog: Scissors,
  hours: Clock,
  reports: ChartColumn,
  integrations: Plug,
  settings: Settings,
};

export function NavGlyph({ icon, ...props }: { icon: NavIcon } & LucideProps) {
  const Icon = icons[icon];
  return <Icon aria-hidden {...props} />;
}
