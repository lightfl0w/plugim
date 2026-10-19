export interface Migration {
    id: string;
    sql: string | null;
}

export const migrations: Migration[] = [{ id: "001-baseline", sql: null }];
