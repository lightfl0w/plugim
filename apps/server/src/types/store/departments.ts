export interface DepartmentRow {
    id: string;
    name: string;
    parentId: string | null;
    sort: number;
    groupId: string | null;
    createdAt: string;
}

export interface DepartmentsStore {
    create(name: string, parentId: string | null): Promise<DepartmentRow>;
    byId(id: string): Promise<DepartmentRow | null>;
    listAll(): Promise<DepartmentRow[]>;
    rename(id: string, name: string): Promise<void>;
    move(id: string, parentId: string | null): Promise<void>;
    remove(id: string): Promise<void>;
    setGroup(id: string, groupId: string | null): Promise<void>;
    memberCounts(): Promise<Record<string, number>>;
}

export interface AuditRow {
    id: string;
    actorId: string | null;
    actor: string;
    action: string;
    detail: string;
    createdAt: string;
}

export interface AuditQuery {
    keyword?: string;
    category?: string;
    offset: number;
    limit: number;
}

export interface AuditStore {
    add(row: Omit<AuditRow, "id" | "createdAt">): Promise<void>;
    list(query: AuditQuery): Promise<{ rows: AuditRow[]; total: number }>;
}
