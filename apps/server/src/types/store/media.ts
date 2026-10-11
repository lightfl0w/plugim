export interface MediaFileRow {
    key: string;
    name: string;
    mime: string;
    size: number;
    uploaderId: string;
    createdAt: string;
}

export interface MediaFilesStore {
    save(row: MediaFileRow): Promise<void>;
    byKey(key: string): Promise<MediaFileRow | null>;
    list(params: {
        offset: number;
        limit: number;
    }): Promise<{ rows: MediaFileRow[]; total: number }>;
    olderThan(iso: string): Promise<MediaFileRow[]>;
    totalBytes(): Promise<number>;
    count(): Promise<number>;
    remove(key: string): Promise<void>;
}
