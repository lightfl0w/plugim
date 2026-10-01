import type { Plugin } from "@plugim/core";
import type { AuditService, AuditStore } from "../types";

const DETAIL_LIMIT = 500;

export const auditPlugin: Plugin = {
    name: "audit",
    description: "审计日志写入服务",
    provides: ["audit"],
    inject: ["audits"],
    async apply(ctx) {
        const audits = ctx.get<AuditStore>("audits");
        const log: AuditService["log"] = async (entry) => {
            try {
                await audits.add({
                    actorId: entry.actorId,
                    actor: entry.actor.slice(0, 64),
                    action: entry.action.slice(0, 64),
                    detail: (entry.detail ?? "").slice(0, DETAIL_LIMIT),
                });
            } catch (err) {
                ctx.log.error("audit log failed", err);
            }
        };
        ctx.provide<AuditService>("audit", { log });
        return undefined;
    },
};
