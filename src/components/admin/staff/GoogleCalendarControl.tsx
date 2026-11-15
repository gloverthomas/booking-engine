"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/ui/toast";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Button, buttonClasses } from "@/components/ui/button";
import type { StaffRowView } from "./types";

const STATUS: Record<
  NonNullable<StaffRowView["google"]>["status"] | "none",
  { label: string; tone: BadgeTone }
> = {
  connected: { label: "Connected", tone: "success" },
  error: { label: "Needs attention", tone: "danger" },
  disconnected: { label: "Not connected", tone: "neutral" },
  none: { label: "Not connected", tone: "neutral" },
};

export function connectHref(staffId: string): string {
  return `/api/integrations/google/connect?staffId=${encodeURIComponent(staffId)}`;
}

export function disconnectHref(staffId: string): string {
  return `/api/integrations/google/disconnect?staffId=${encodeURIComponent(staffId)}`;
}

interface Props {
  staffId: string;
  google: StaffRowView["google"];
  /** Whether the Google keys are on the server; without them there is nothing to connect to. */
  configured: boolean;
}

/** One person's Google Calendar: status, a connect / reconnect link and a disconnect button. */
export function GoogleCalendarControl({ staffId, google, configured }: Props) {
  const status = STATUS[google?.status ?? "none"];
  const isLinked = google !== null && google.status !== "disconnected";
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  const { toast } = useToast();

  async function disconnect() {
    setBusy(true);
    try {
      const response = await fetch(disconnectHref(staffId), { method: "POST" });
      if (!response.ok) throw new Error(String(response.status));
      toast({ title: "Google Calendar disconnected", tone: "success" });
      router.refresh();
    } catch {
      toast({
        title: "Couldn't disconnect",
        description: "Try again, or ask the owner.",
        tone: "danger",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-[0.06em] text-ink-subtle">
          Google Calendar
        </span>
        <Badge tone={status.tone}>{status.label}</Badge>
      </div>
      {google?.calendar ? <p className="truncate text-sm text-ink-muted">{google.calendar}</p> : null}
      {google?.lastSyncText ? (
        <p className="text-xs text-ink-subtle">Last sync {google.lastSyncText}</p>
      ) : null}
      {google?.lastError ? <p className="text-sm text-danger">{google.lastError}</p> : null}
      {configured ? (
        <div className="flex flex-wrap gap-2">
          {/* A plain anchor: the connect route redirects to Google, so it must be a full navigation. */}
          <a
            href={connectHref(staffId)}
            className={buttonClasses({ variant: isLinked ? "secondary" : "primary", size: "sm" })}
          >
            {isLinked ? "Reconnect Google Calendar" : "Connect Google Calendar"}
          </a>
          {isLinked ? (
            <Button variant="ghost" size="sm" loading={busy} onClick={disconnect}>
              Disconnect
            </Button>
          ) : null}
        </div>
      ) : (
        <p className="text-xs text-ink-subtle">Google isn&apos;t set up on the server yet.</p>
      )}
    </div>
  );
}
