import type {
    AABillInfo,
    ChatMessage,
    FileMeta,
    LinkPreview,
    MessageKind,
    MessageQuote,
    MessageReactions,
    RedPacketInfo,
    TransferInfo,
} from "@plugim/protocol";
import type { MessageTrendPoint } from "../shared";

export interface MessageCursor {
    before?: string;
    after?: string;
    beforeId?: string;
    afterId?: string;
    beforeSeq?: number;
    afterSeq?: number;
}

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
        transfer?: TransferInfo | null;
        aaBill?: AABillInfo | null;
    }): Promise<ChatMessage>;

    list(
        session: string,
        limit: number,
        cursor?: MessageCursor,
    ): Promise<ChatMessage[]>;

    lastSeq(session: string): Promise<number>;

    summaries(input: {
        userId: string;
        username: string;
        sessions: string[];
    }): Promise<
        {
            session: string;
            lastSeq: number;
            readSeq: number;
            unread: number;
            lastMessage: ChatMessage | null;
        }[]
    >;

    since(input: {
        session: string;
        seq: number;
        limit: number;
    }): Promise<ChatMessage[]>;

    byId(id: string): Promise<ChatMessage | null>;
    markRecalled(id: string): Promise<string | null>;
    edit(id: string, content: string, at: string): Promise<ChatMessage | null>;
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
