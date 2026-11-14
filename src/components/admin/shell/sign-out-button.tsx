import { LogOut } from "lucide-react";
import { buttonClasses } from "@/components/ui/button";
import { cn } from "@/components/ui/cn";
import { signOutAction } from "./actions";

/** A form so signing out works without JavaScript and is a POST (never a GET link). */
export function SignOutButton({ className }: { className?: string }) {
  return (
    <form action={signOutAction}>
      <button
        type="submit"
        className={cn(
          buttonClasses({ variant: "ghost", fullWidth: true }),
          "justify-start",
          className,
        )}
      >
        <LogOut aria-hidden className="size-4" />
        Sign out
      </button>
    </form>
  );
}
