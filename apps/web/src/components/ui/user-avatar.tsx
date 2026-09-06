import { cn } from "../../lib/utils";
import { Avatar, AvatarFallback } from "./avatar";

function hashName(name: string): number {
    let h = 0;
    for (let i = 0; i < name.length; i++) {
        h = (h * 31 + name.charCodeAt(i)) | 0;
    }
    return Math.abs(h);
}

const palette = [
    "bg-rose-500",
    "bg-orange-500",
    "bg-amber-500",
    "bg-emerald-500",
    "bg-teal-500",
    "bg-sky-500",
    "bg-indigo-500",
    "bg-violet-500",
    "bg-fuchsia-500",
];

export interface UserAvatarProps {
    name: string;
    size?: "sm" | "default" | "lg";
    className?: string;
}

export function UserAvatar({ name, size, className }: UserAvatarProps) {
    const bg = palette[hashName(name) % palette.length];
    const letter = (name[0] ?? "?").toUpperCase();
    return (
        <Avatar size={size} className={className} title={name}>
            <AvatarFallback className={cn(bg, "text-white")}>
                {letter}
            </AvatarFallback>
        </Avatar>
    );
}
