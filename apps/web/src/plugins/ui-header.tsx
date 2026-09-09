import type { Plugin } from "@plugim/core";
import { useEffect, useState } from "react";
import { Badge } from "../components/ui/badge";
import type { ConnStatus, RpcService } from "./connection";
import type { UiService } from "./ui";

const statusLabel: Record<
    ConnStatus,
    {
        text: string;
        variant: "outline" | "secondary";
        className?: string;
    }
> = {
    open: {
        text: "已连接",
        variant: "outline",
        className: "border-emerald-600/40 text-emerald-600",
    },
    connecting: { text: "连接中", variant: "secondary" },
    closed: { text: "已断开", variant: "secondary" },
};

export const uiHeaderPlugin: Plugin = {
    name: "ui-header",
    description: "聊天顶部状态栏",
    inject: ["ui", "rpc"],
    async apply(ctx) {
        const ui = ctx.get<UiService>("ui");
        const rpc = ctx.get<RpcService>("rpc");

        const Header = () => {
            const [status, setStatus] = useState(rpc.status());
            const [title, setTitle] = useState("群聊");

            useEffect(() => rpc.onStatus(setStatus), []);

            useEffect(() => {
                const dispose = ctx.on("ui:chat:open", (payload) => {
                    setTitle((payload as { title?: string }).title ?? "群聊");
                });
                return () => {
                    void dispose();
                };
            }, []);

            const badge = statusLabel[status];
            return (
                <div className="flex items-center gap-2">
                    <p className="text-sm font-semibold">{title}</p>
                    <Badge variant={badge.variant} className={badge.className}>
                        {badge.text}
                    </Badge>
                </div>
            );
        };

        return ui.register("header", Header);
    },
};
