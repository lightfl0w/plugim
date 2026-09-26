import type { FC } from "react";

export type UiSlot =
    | "auth"
    | "nav"
    | "sidebar"
    | "header"
    | "messages"
    | "composer"
    | "friends-list"
    | "friends-detail"
    | "overlay";

export interface UiService {
    Slot: FC<{ slot: UiSlot; className?: string }>;
    register(slot: UiSlot, component: FC, order?: number): () => void;
    registerRoute(path: string, component: FC): () => void;
}
