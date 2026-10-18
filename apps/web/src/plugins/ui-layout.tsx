import { ArrowLeftIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "../components/ui/button";

export const panelRow =
    "flex flex-wrap items-center gap-3 border-b border-border px-4 py-3.5 last:border-b-0";

export const panelBody = "space-y-3 px-4 py-3.5";

export const inputClass =
    "h-8 rounded-lg border border-border bg-card px-2.5 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

export const pillClass = (on: boolean) =>
    on
        ? "rounded-full bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground"
        : "rounded-full border border-border px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground";

export const codeClass =
    "block overflow-x-auto rounded-lg bg-muted/60 px-3 py-2.5 font-mono text-[11px] leading-relaxed text-foreground/80";

export const Field = ({
    title,
    desc,
    children,
}: {
    title: string;
    desc?: string;
    children?: ReactNode;
}) => (
    <div className="min-w-0 flex-1 space-y-1">
        <p className="text-sm font-medium leading-tight">{title}</p>
        {desc ? (
            <p className="text-xs leading-relaxed text-muted-foreground">
                {desc}
            </p>
        ) : null}
        {children}
    </div>
);

export const Panel = ({
    icon,
    title,
    desc,
    actions,
    children,
    innerRef,
    id,
}: {
    icon?: ReactNode;
    title: string;
    desc?: string;
    actions?: ReactNode;
    children: ReactNode;
    innerRef?: (node: HTMLElement | null) => void;
    id?: string;
}) => (
    <section
        id={id}
        ref={innerRef}
        className="scroll-mt-20 overflow-hidden rounded-xl border border-border bg-card"
    >
        <header className="flex items-center gap-2.5 border-b border-border px-4 py-3">
            {icon ? (
                <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary [&_svg]:size-4">
                    {icon}
                </span>
            ) : null}
            <h3 className="text-sm font-semibold">{title}</h3>
            {actions ? (
                <div className="ml-auto flex shrink-0 items-center gap-1.5">
                    {actions}
                </div>
            ) : null}
        </header>
        {desc ? (
            <p className="border-b border-border px-4 py-2.5 text-xs leading-relaxed text-muted-foreground">
                {desc}
            </p>
        ) : null}
        {children}
    </section>
);

export const Note = ({
    tone = "info",
    children,
}: {
    tone?: "info" | "error";
    children: ReactNode;
}) => (
    <p
        className={
            tone === "error"
                ? "flex items-start gap-2 border-t border-border px-4 py-3 text-xs leading-relaxed text-destructive"
                : "border-t border-border px-4 py-3 text-xs leading-relaxed text-muted-foreground"
        }
    >
        {children}
    </p>
);

export const PageShell = ({
    title,
    subtitle,
    nav,
    onBack,
    children,
    width = "max-w-2xl",
}: {
    title: string;
    subtitle?: string;
    nav?: ReactNode;
    onBack: () => void;
    children: ReactNode;
    width?: string;
}) => (
    <div className="flex h-full flex-col">
        <div className="flex h-12 min-h-12 shrink-0 items-center gap-1 border-b border-border px-3">
            <Button
                variant="ghost"
                size="icon-sm"
                title="返回"
                onClick={onBack}
            >
                <ArrowLeftIcon />
            </Button>
            <p className="text-sm font-semibold">{title}</p>
            {subtitle ? (
                <span className="truncate text-xs text-muted-foreground">
                    {subtitle}
                </span>
            ) : null}
            {nav}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
            <div className={`mx-auto w-full ${width} space-y-4 pb-8`}>
                {children}
            </div>
        </div>
    </div>
);
