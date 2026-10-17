export interface AuditService {
    log(entry: {
        actorId: string | null;
        actor: string;
        action: string;
        detail?: string;
    }): Promise<void>;
}
