import type { Plugin } from "@plugim/core";
import type { GroupFileItem } from "@plugim/protocol";
import type {
    AccountsStore,
    AuthUser,
    ChatSendPayload,
    ChatService,
    ConnInfo,
    GatewayService,
    GroupAclService,
    GroupFilesStore,
    MediaFilesStore,
    MessageStore,
} from "../types";
import type { FileService } from "./files";

const KEY_RE = /^[a-f0-9]{32}$/;

const requireUser = (conn: ConnInfo): AuthUser => {
    if (!conn.user) throw new Error("未登录或登录已过期");
    return conn.user;
};

export const groupFilesPlugin: Plugin = {
    name: "group-files",
    description: "群文件共享",
    provides: ["group-files-rpc"],
    inject: [
        "gateway",
        "accounts",
        "group-acl",
        "groupFiles",
        "mediaFiles",
        "files",
        "store",
        "chat",
    ],
    async apply(ctx) {
        const gateway = ctx.get<GatewayService>("gateway");
        const accounts = ctx.get<AccountsStore>("accounts");
        const acl = ctx.get<GroupAclService>("group-acl");
        const groupFiles = ctx.get<GroupFilesStore>("groupFiles");
        const mediaFiles = ctx.get<MediaFilesStore>("mediaFiles");
        const files = ctx.get<FileService>("files");
        const store = ctx.get<MessageStore>("store");
        const chat = ctx.get<ChatService>("chat");

        const updateMembers = (memberIds: string[], groupId: string) => {
            for (const id of memberIds)
                gateway.emitToUser(id, "group:update", { groupId });
        };

        gateway.rpc("group.file.list", async (raw, conn) => {
            const me = requireUser(conn);
            const params = raw as unknown as {
                groupId?: string;
                offset?: number;
                limit?: number;
            };
            const groupId = String(params.groupId ?? "");
            await acl.requireMembership(groupId, me);
            const result = await groupFiles.list(groupId, {
                offset: Math.max(0, Number(params.offset) || 0),
                limit: Math.min(Math.max(Number(params.limit) || 50, 1), 100),
            });
            const uploaders = await accounts.byIds(
                result.rows.map((row) => row.uploaderId),
            );
            const nameById = new Map(
                uploaders.map((row) => [row.id, row.username]),
            );
            const items: GroupFileItem[] = result.rows.map((row) => ({
                key: row.key,
                name: row.name,
                mime: row.mime,
                size: row.size,
                uploader: nameById.get(row.uploaderId) ?? row.uploaderId,
                createdAt: row.createdAt,
            }));
            return { files: items, total: result.total };
        });

        gateway.rpc("group.file.add", async (raw, conn) => {
            const me = requireUser(conn);
            const { groupId, key } = raw as unknown as {
                groupId?: string;
                key?: string;
            };
            const { row, members } = await acl.requireMembership(
                String(groupId ?? ""),
                me,
            );
            const fileKey = String(key ?? "");
            if (!KEY_RE.test(fileKey)) throw new Error("文件不存在");
            const media = await mediaFiles.byKey(fileKey);
            if (!media) throw new Error("文件不存在");
            if (media.uploaderId !== me.id)
                throw new Error("只能添加自己上传的文件");
            await groupFiles.save({
                groupId: row.id,
                key: fileKey,
                name: media.name,
                mime: media.mime,
                size: media.size,
                uploaderId: me.id,
                createdAt: new Date().toISOString(),
            });
            const payload: ChatSendPayload = {
                content: files.url(fileKey),
                quote: null,
                mentions: null,
                kind: "file",
                file: {
                    name: media.name,
                    size: media.size,
                    mime: media.mime,
                },
            };
            await chat
                .sendTo(me, acl.sessionOf(row.id), payload)
                .catch(() => undefined);
            updateMembers(
                members.map((member) => member.userId),
                row.id,
            );
            return { key: fileKey };
        });

        gateway.rpc("group.file.delete", async (raw, conn) => {
            const me = requireUser(conn);
            const { groupId, key } = raw as unknown as {
                groupId?: string;
                key?: string;
            };
            const { row, members, mine } = await acl.requireMembership(
                String(groupId ?? ""),
                me,
            );
            const entry = await groupFiles.byKey(row.id, String(key ?? ""));
            if (!entry) throw new Error("文件不存在");
            if (
                entry.uploaderId !== me.id &&
                mine !== "owner" &&
                mine !== "admin"
            )
                throw new Error("只有上传者或群管理可以删除");
            await groupFiles.remove(row.id, entry.key);
            const inGroups = await groupFiles.countByKey(entry.key);
            const inMessages = await store.countByContent(files.url(entry.key));
            if (inGroups === 0 && inMessages === 0) {
                await files.remove(entry.key);
                await mediaFiles.remove(entry.key);
            }
            updateMembers(
                members.map((member) => member.userId),
                row.id,
            );
            return true;
        });
        return undefined;
    },
};
