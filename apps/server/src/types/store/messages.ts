import type {
    ChatMessage,
    FileMeta,
    LinkPreview,
    MessageKind,
    MessageQuote,
    MessageReactions,
    RedPacketInfo,
} from "@plugim/protocol";
import type { MessageTrendPoint } from "../shared";

export interface MessageStore {
    save(input: {
        session: string;
        sender: string;
        content: string;
        quote?: MessageQuote | null;
        mentions?: string[] | null;
        kind?: MessageKind;
        file?: FileMeta | null;
        link?: LinkPreview | null;
        redPacket?: RedPacketInfo | null;
    }): Promise<ChatMessage>;

    list(
        session: string,
        limit: number,
        before?: string,
        after?: string,
        beforeId?: string,
        afterId?: string,
    ): Promise<ChatMessage[]>;

    byId(id: string): Promise<ChatMessage | null>;
    markRecalled(id: string): Promise<string | null>;
    setReactions(
        id: string,
        reactions: MessageReactions | null,
    ): Promise<ChatMessage | null>;

    search(params: {
        keyword?: string;
        session?: string;
        sessions?: string[];
        sender?: string;
        media?: boolean;
        offset: number;
        limit: number;
    }): Promise<{ rows: ChatMessage[]; total: number }>;

    deleteOlderThan(iso: string): Promise<ChatMessage[]>;
    countByContent(content: string): Promise<number>;
    trend(days: number): Promise<MessageTrendPoint[]>;
    count(): Promise<number>;
    mediaBytes(): Promise<number>;
}
