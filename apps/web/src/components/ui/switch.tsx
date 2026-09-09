import { cn } from "../../lib/utils";

export function Switch({
    checked,
    disabled,
    onToggle,
}: {
    checked: boolean;
    disabled?: boolean;
    onToggle: () => void;
}) {
    return (
        <button
            type="button"
            role="switch"
            aria-checked={checked}
            disabled={disabled}
            onClick={onToggle}
            className={cn(
                "inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-transparent p-0.5 transition-colors",
                checked ? "bg-primary" : "bg-input",
                disabled
                    ? "cursor-not-allowed opacity-50"
                    : "cursor-pointer hover:opacity-90",
            )}
        >
            <span
                className={cn(
                    "block size-4 rounded-full bg-background shadow-sm transition-transform",
                    checked && "translate-x-4",
                )}
            />
        </button>
    );
}
