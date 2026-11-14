import type { SVGProps } from "react";

type IconProps = Omit<SVGProps<SVGSVGElement>, "children"> & { size?: number };

function Svg({ size = 20, ...props }: IconProps & { children?: never }, path: string) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="square"
      strokeLinejoin="miter"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      <path d={path} />
    </svg>
  );
}

export const ArrowRight = (p: IconProps) => Svg(p, "M4 12h15M13 6l6 6-6 6");
export const ArrowLeft = (p: IconProps) => Svg(p, "M20 12H5M11 6l-6 6 6 6");
export const Check = (p: IconProps) => Svg(p, "M4 12.5l5 5L20 6.5");
export const ChevronLeft = (p: IconProps) => Svg(p, "M15 5l-7 7 7 7");
export const ChevronRight = (p: IconProps) => Svg(p, "M9 5l7 7-7 7");
export const Alert = (p: IconProps) => Svg(p, "M12 4v10M12 18v2");
