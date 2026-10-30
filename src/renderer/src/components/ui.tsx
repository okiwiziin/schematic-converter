// The app's small set of controls.
import {
  type ButtonHTMLAttributes,
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

export function cn(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

type ButtonVariant =
  | "default"
  | "outline"
  | "ghost"
  | "bar"
  | "bar-primary"
  | "bar-danger";
type ButtonSize = "lg" | "sm" | "xs" | "icon-sm" | "icon-xs";

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  // Translucent glass pills, so they take on the bar behind them and blend into it.
  bar: "rounded-full border-border bg-foreground/5 text-foreground/90 backdrop-blur-md hover:border-input hover:bg-foreground/10 hover:text-foreground",
  "bar-danger":
    "rounded-full border-error/24 bg-error/10 text-error-foreground hover:bg-error/16",
  "bar-primary":
    "rounded-full border-primary bg-primary text-primary-foreground hover:bg-primary/88 disabled:border-border disabled:bg-foreground/5 disabled:text-muted-foreground disabled:opacity-100",
  default:
    "border-primary bg-primary text-primary-foreground hover:bg-primary/88",
  ghost:
    "border-transparent text-muted-foreground hover:bg-foreground/7 hover:text-foreground",
  outline: "border-input bg-foreground/4 text-foreground hover:bg-foreground/9",
};

const BUTTON_SIZES: Record<ButtonSize, string> = {
  "icon-sm": "size-7 [&_svg]:size-3.5",
  "icon-xs": "size-6 rounded-md [&_svg]:size-3.5",
  lg: "h-8.5 gap-2 px-3 text-[13px] [&_svg]:size-4",
  sm: "h-7 gap-1.5 px-2.75 text-xs [&_svg]:size-3.5",
  xs: "h-6 gap-1 rounded-md px-2 text-xs [&_svg]:size-3.5",
};

export function Button({
  variant = "outline",
  size = "sm",
  className,
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
}) {
  return (
    <button
      className={cn(
        "focus-visible:ring-ring relative inline-flex shrink-0 cursor-pointer items-center justify-center rounded-lg border font-medium whitespace-nowrap transition-[background-color,border-color,color,scale] outline-none focus-visible:ring-2 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0",
        BUTTON_VARIANTS[variant],
        BUTTON_SIZES[size],
        className
      )}
      type={type}
      {...props}
    />
  );
}

export function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
}) {
  return (
    <button
      aria-checked={checked}
      aria-label={label}
      className={cn(
        "focus-visible:ring-ring inline-flex h-4.5 w-8 shrink-0 cursor-pointer items-center rounded-full p-0.5 transition-colors duration-200 outline-none focus-visible:ring-2",
        checked ? "bg-primary" : "bg-foreground/10"
      )}
      onClick={() => onChange(!checked)}
      role="switch"
      type="button"
    >
      <span
        className={cn(
          "block size-3.5 rounded-full transition-[translate,background-color] duration-200",
          checked ? "bg-primary-foreground translate-x-3.5" : "bg-foreground/45"
        )}
      />
    </button>
  );
}

// Rendered in a portal so it's never clipped by the scrolling list it was opened from.
export function Popover({
  trigger,
  children,
  className,
}: {
  trigger: (props: { open: boolean; toggle: () => void }) => ReactNode;
  children: (close: () => void) => ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [style, setStyle] = useState<CSSProperties>({ visibility: "hidden" });
  const triggerRef = useRef<HTMLDivElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);

  useLayoutEffect(() => {
    if (!(open && triggerRef.current && popupRef.current)) {
      return;
    }
    const anchor = triggerRef.current.getBoundingClientRect();
    const popup = popupRef.current.getBoundingClientRect();
    const fitsBelow =
      anchor.bottom + 4 + popup.height <= window.innerHeight - 8;
    setStyle({
      left: Math.min(
        Math.max(8, anchor.right - popup.width),
        window.innerWidth - popup.width - 8
      ),
      top: fitsBelow
        ? anchor.bottom + 4
        : Math.max(8, anchor.top - 4 - popup.height),
    });
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointer = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (
        !(
          triggerRef.current?.contains(target) ||
          popupRef.current?.contains(target)
        )
      ) {
        close();
      }
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        close();
      }
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", close);
    };
  }, [open, close]);

  return (
    <div className="inline-flex" ref={triggerRef}>
      {trigger({ open, toggle: () => setOpen((value) => !value) })}
      {open &&
        createPortal(
          <div
            className={cn(
              "surface-glass border-input fixed z-50 rounded-xl border p-1 shadow-xl/20",
              className
            )}
            ref={popupRef}
            style={style}
          >
            {children(close)}
          </div>,
          document.body
        )}
    </div>
  );
}

export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  label,
  fill = false,
  size = "sm",
}: {
  value: T;
  options: { value: T; label: string; count?: number; title?: string }[];
  onChange: (value: T) => void;
  label: string;
  fill?: boolean;
  size?: "sm" | "md";
}) {
  return (
    <div
      aria-label={label}
      className={cn(
        "border-border rounded-lg border p-0.5",
        fill ? "flex" : "inline-flex"
      )}
      role="radiogroup"
    >
      {options.map((option) => (
        <button
          aria-checked={option.value === value}
          className={cn(
            "focus-visible:ring-ring inline-flex cursor-pointer items-center justify-center gap-1 rounded-md border px-1.5 font-medium whitespace-nowrap transition-colors outline-none focus-visible:ring-2",
            size === "md" ? "h-6 px-2.5 text-xs" : "text-2xs h-5",
            fill && "flex-1",
            option.value === value
              ? "border-input bg-foreground/7 text-foreground"
              : "text-muted-foreground hover:text-foreground border-transparent"
          )}
          key={String(option.value)}
          onClick={() => onChange(option.value)}
          role="radio"
          title={option.title}
          type="button"
        >
          {option.label}
          {option.count !== undefined && (
            <span className="text-3xs font-mono tabular-nums opacity-60">
              {option.count}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

export function ProgressBar({
  fraction,
  className,
}: {
  fraction: number | null;
  className?: string;
}) {
  return (
    <div
      aria-valuemax={100}
      aria-valuemin={0}
      aria-valuenow={fraction === null ? undefined : Math.round(fraction * 100)}
      className={cn(
        "bg-foreground/10 h-1 w-full overflow-hidden rounded-full",
        className
      )}
      role="progressbar"
    >
      {fraction === null ? (
        <div className="progress-indeterminate bg-foreground h-full w-1/3 rounded-full" />
      ) : (
        <div
          className="bg-foreground h-full rounded-full transition-[width] duration-150"
          style={{ width: `${Math.max(2, fraction * 100)}%` }}
        />
      )}
    </div>
  );
}
