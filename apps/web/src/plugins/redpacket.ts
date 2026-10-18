import type { Plugin } from "@plugim/core";
import type { RedPacketDetail, RedPacketSummary } from "@plugim/protocol";
import type { RpcService } from "./connection";

export interface RedPacketCreateResult {
    packet: RedPacketSummary;
}

export interface RedPacketClaimResult {
    amount: number;
    packet: RedPacketSummary;
}

export interface RedPacketService {
    create(params: {
        sessionId: string;
        type: "normal" | "lucky";
        totalAmount: number;
        totalCount: number;
        message?: string;
    }): Promise<RedPacketCreateResult>;
    claim(params: { redPacketId: string }): Promise<RedPacketClaimResult>;
    detail(params: { redPacketId: string }): Promise<RedPacketDetail>;
    records(params: {
        redPacketId: string;
    }): Promise<RedPacketDetail["records"]>;
    expire(): Promise<number>;
}

export const redpacketPlugin: Plugin = {
    name: "redpacket",
    description: "红包客户端服务",
    inject: ["rpc"],
    async apply(ctx) {
        const rpc = ctx.get<RpcService>("rpc");
        const service: RedPacketService = {
            create: (params) =>
                rpc.call(
                    "redpacket.create",
                    params,
                ) as Promise<RedPacketCreateResult>,
            claim: (params) =>
                rpc.call(
                    "redpacket.claim",
                    params,
                ) as Promise<RedPacketClaimResult>,
            detail: (params) =>
                rpc.call(
                    "redpacket.detail",
                    params,
                ) as Promise<RedPacketDetail>,
            records: (params) =>
                rpc.call("redpacket.records", params) as Promise<
                    RedPacketDetail["records"]
                >,
            expire: () => rpc.call("redpacket.expire", {}) as Promise<number>,
        };
        ctx.provide<RedPacketService>("redpacket", service);
        return undefined;
    },
};
