"use client";

import {
  createContext,
  useContext,
  useId,
  useState,
  type ComponentProps,
  type KeyboardEvent,
} from "react";
import { cn } from "./cn";
import { nextTabIndex } from "./tabs-logic";

interface TabsContextValue {
  value: string;
  select: (value: string) => void;
  baseId: string;
}

const TabsContext = createContext<TabsContextValue | null>(null);

function useTabs(): TabsContextValue {
  const ctx = useContext(TabsContext);
  if (!ctx) throw new Error("Tabs parts must be used inside <Tabs>");
  return ctx;
}

export interface TabsProps extends Omit<ComponentProps<"div">, "defaultValue" | "onChange"> {
  /** Uncontrolled initial tab. */
  defaultValue?: string;
  /** Controlled value. */
  value?: string;
  onValueChange?: (value: string) => void;
}

/**
 * Compound tabs: <Tabs><TabsList><TabsTrigger value/></TabsList><TabsContent value/></Tabs>.
 * Arrow keys, Home and End move between tabs; only the selected tab is in the tab order.
 */
export function Tabs({
  defaultValue = "",
  value: controlled,
  onValueChange,
  className,
  ...rest
}: TabsProps) {
  const [internal, setInternal] = useState(defaultValue);
  const baseId = useId();
  const value = controlled ?? internal;
  const select = (next: string) => {
    if (controlled === undefined) setInternal(next);
    onValueChange?.(next);
  };
  return (
    <TabsContext value={{ value, select, baseId }}>
      <div className={className} {...rest} />
    </TabsContext>
  );
}

export function TabsList({ className, ...rest }: ComponentProps<"div">) {
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const tabs = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]:not([disabled])'),
    );
    const current = tabs.findIndex((tab) => tab === document.activeElement);
    const next = nextTabIndex(event.key, current < 0 ? 0 : current, tabs.length);
    if (next === null) return;
    event.preventDefault();
    tabs[next]?.focus();
    tabs[next]?.click();
  }
  return (
    <div
      role="tablist"
      onKeyDown={onKeyDown}
      className={cn("flex gap-1 overflow-x-auto border-b border-line", className)}
      {...rest}
    />
  );
}

export interface TabsTriggerProps extends Omit<ComponentProps<"button">, "value"> {
  value: string;
}

export function TabsTrigger({ value, className, children, ...rest }: TabsTriggerProps) {
  const ctx = useTabs();
  const selected = ctx.value === value;
  return (
    <button
      type="button"
      role="tab"
      id={`${ctx.baseId}-tab-${value}`}
      aria-selected={selected}
      aria-controls={`${ctx.baseId}-panel-${value}`}
      tabIndex={selected ? 0 : -1}
      onClick={() => ctx.select(value)}
      className={cn(
        "relative -mb-px inline-flex min-h-11 shrink-0 items-center px-4 text-[0.9375rem] font-semibold",
        "border-b-2 transition-colors duration-[var(--duration-fast)]",
        selected ? "border-ink text-ink" : "border-transparent text-ink-muted hover:text-ink",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

export interface TabsContentProps extends Omit<ComponentProps<"div">, "value"> {
  value: string;
}

export function TabsContent({ value, className, ...rest }: TabsContentProps) {
  const ctx = useTabs();
  if (ctx.value !== value) return null;
  return (
    <div
      role="tabpanel"
      id={`${ctx.baseId}-panel-${value}`}
      aria-labelledby={`${ctx.baseId}-tab-${value}`}
      tabIndex={0}
      className={cn("pt-4", className)}
      {...rest}
    />
  );
}
