import type { ComponentProps, ReactNode } from "react";
import { CircleAlert, CircleCheck, Info, TriangleAlert } from "lucide-react";
import { cn } from "./cn";

export type AlertTone = "info" | "success" | "warning" | "danger";

const tones: Record<AlertTone, { box: string; icon: typeof Info }> = {
  info: { box: "border-info bg-info-tint text-info", icon: Info },
  success: { box: "border-success bg-success-tint text-success", icon: CircleCheck },
  warning: { box: "border-warning bg-warning-tint text-warning", icon: TriangleAlert },
  danger: { box: "border-danger bg-danger-tint text-danger", icon: CircleAlert },
};

export interface AlertProps extends Omit<ComponentProps<"div">, "title"> {
  tone?: AlertTone;
  title?: ReactNode;
}

/** An inline message. Errors use role="alert" so they are announced; the rest are role="status". */
export function Alert({ tone = "info", title, className, children, ...rest }: AlertProps) {
  const { box, icon: Icon } = tones[tone];
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      className={cn("flex items-start gap-3 rounded-card border px-4 py-3", box, className)}
      {...rest}
    >
      <Icon aria-hidden className="mt-0.5 size-5 shrink-0" />
      <div className="min-w-0 text-sm">
        {title ? <p className="font-semibold">{title}</p> : null}
        {children ? <div className={cn(title && "mt-0.5")}>{children}</div> : null}
      </div>
    </div>
  );
}
