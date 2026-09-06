import type { Plugin } from "@plugim/core";
import { UsersIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import type { ConnStatus, RpcService } from "./connection";
import type { UiService } from "./shell";

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
    inject: ["ui", "rpc"],
    async apply(ctx) {
        const ui = ctx.get<UiService>("ui");
        const rpc = ctx.get<RpcService>("rpc");

        const Header = () => {
            const [status, setStatus] = useState(rpc.status());

            useEffect(() => rpc.onStatus(setStatus), [rpc]);

            const badge = statusLabel[status];
            return (
                <>
                    <div className="flex items-center gap-2">
                        <Badge
                            variant={badge.variant}
                            className={badge.className}
                        >
                            {badge.text}
                        </Badge>
                    </div>
                    <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => ctx.emit("ui:friends:toggle")}
                    >
                        <UsersIcon />
                        好友
                    </Button>
                </>
            );
        };

        ui.register("header", Header);
        return undefined;
    },
};
