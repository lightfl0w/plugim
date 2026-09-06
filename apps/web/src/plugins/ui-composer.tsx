import type { Plugin } from "@plugim/core";
import { SendHorizontalIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "../components/ui/button";
import { Textarea } from "../components/ui/textarea";
import type { ConnStatus, RpcService } from "./connection";
import type { SenderService } from "./sender";
import type { UiService } from "./shell";

export const uiComposerPlugin: Plugin = {
    name: "ui-composer",
    inject: ["ui", "rpc", "sender"],
    async apply(ctx) {
        const ui = ctx.get<UiService>("ui");
        const rpc = ctx.get<RpcService>("rpc");
        const sender = ctx.get<SenderService>("sender");
        let currentSession = "general";

        ctx.on("ui:chat:open", (payload) => {
            currentSession = (payload as { session: string }).session;
        });

        const Composer = () => {
            const [draft, setDraft] = useState("");
            const [status, setStatus] = useState<ConnStatus>(rpc.status());
            const [sending, setSending] = useState(false);

            useEffect(() => rpc.onStatus(setStatus), []);

            const submit = async () => {
                const content = draft.trim();
                if (!content || sending) return;
                setSending(true);
                try {
                    await sender.send(currentSession, content);
                    setDraft("");
                } finally {
                    setSending(false);
                }
            };

            return (
                <div className="w-full relative">
                    <Textarea
                        value={draft}
                        placeholder={
                            status === "open" ? "输入消息..." : "等待连接..."
                        }
                        disabled={status !== "open"}
                        className="flex-1 max-h-40 pr-12"
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === "Enter" && !e.shiftKey) {
                                e.preventDefault();
                                void submit();
                            }
                        }}
                    />
                    <Button
                        size="icon"
                        className="absolute right-2 bottom-2 size-8"
                        disabled={status !== "open" || sending || !draft.trim()}
                        onClick={() => void submit()}
                    >
                        <SendHorizontalIcon />
                    </Button>
                </div>
            );
        };

        ui.register("composer", Composer);
        return undefined;
    },
};
