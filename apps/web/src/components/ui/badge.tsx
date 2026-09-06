import type { HTMLAttributes } from "react";
import { cn } from "../../lib/utils";

type Variant = "default" | "success" | "muted";

const variants: Record<Variant, string> = {
    default: "bg-primary text-primary-foreground",
    success: "bg-transparent text-emerald-600 border border-emerald-600/40",
    muted: "bg-muted text-muted-foreground",
};

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
    variant?: Variant;
}

export function Badge({
    className,
    variant = "default",
    ...props
}: BadgeProps) {
    return (
        <span
            className={cn(
                "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium",
                variants[variant],
                className,
            )}
            {...props}
        />
    );
}
