import type { Plugin } from "@plugim/core";
import { useEffect, useState } from "react";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import type { AuthService } from "./auth";
import type { ConnStatus, RpcService } from "./connection";
import type { UiService } from "./shell";

const statusLabel: Record<
    ConnStatus,
    { text: string; variant: "success" | "muted" }
> = {
    open: { text: "已连接", variant: "success" },
    connecting: { text: "连接中", variant: "muted" },
    closed: { text: "已断开", variant: "muted" },
};

export const uiHeaderPlugin: Plugin = {
    name: "ui-header",
    inject: ["ui", "auth", "rpc"],
    async apply(ctx) {
        const ui = ctx.get<UiService>("ui");
        const auth = ctx.get<AuthService>("auth");
        const rpc = ctx.get<RpcService>("rpc");

        const Header = () => {
            const [status, setStatus] = useState(rpc.status());
            const user = auth.user();

            useEffect(() => rpc.onStatus(setStatus), [rpc]);

            const badge = statusLabel[status];
            return (
                <>
                    <div className="flex items-center gap-2">
                        <Badge variant={badge.variant}>{badge.text}</Badge>
                        {user ? (
                            <Badge variant="muted">{user.username}</Badge>
                        ) : null}
                    </div>
                    <div className="flex items-center gap-1">
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={() => ctx.emit("ui:friends:toggle")}
                        >
                            好友
                        </Button>
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => auth.logout()}
                        >
                            退出
                        </Button>
                    </div>
                </>
            );
        };

        ui.register("header", Header);
        return undefined;
    },
};
