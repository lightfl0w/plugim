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
    description: "消息输入框",
    inject: ["ui", "rpc", "sender"],
    async apply(ctx) {
        const ui = ctx.get<UiService>("ui");
        const rpc = ctx.get<RpcService>("rpc");
        const sender = ctx.get<SenderService>("sender");
        let currentSession = "general";

        const disposeOpen = ctx.on("ui:chat:open", (payload) => {
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
                <div className="w-full flex items-center gap-2.5">
                    <Textarea
                        value={draft}
                        placeholder={
                            status === "open" ? "输入消息..." : "等待连接..."
                        }
                        disabled={status !== "open"}
                        className="max-h-32 border-0 bg-transparent px-1 focus-visible:border-0 focus-visible:ring-0 shadow-none"
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
                        className="shrink-0 rounded-xl"
                        disabled={status !== "open" || sending || !draft.trim()}
                        onClick={() => void submit()}
                    >
                        <SendHorizontalIcon />
                    </Button>
                </div>
            );
        };

        const unregister = ui.register("composer", Composer);
        return () => {
            unregister();
            disposeOpen();
        };
    },
};
