import type { AdminUserRow, User, UserWithHash } from "../shared";

export interface AccountsStore {
    create(username: string, passwordHash: string): Promise<User>;
    byUsername(username: string): Promise<UserWithHash | null>;
    byId(id: string): Promise<User | null>;
    byIds(ids: string[]): Promise<User[]>;
    fullById(id: string): Promise<UserWithHash | null>;
    listAll(): Promise<AdminUserRow[]>;
    setFlag(
        id: string,
        flag: "isAdmin" | "banned",
        value: boolean,
    ): Promise<void>;
    setPassword(id: string, passwordHash: string): Promise<number>;
    setOrg(
        id: string,
        deptId: string | null,
        title: string | null,
    ): Promise<void>;
    setMustChange(id: string, on: boolean): Promise<void>;
    count(): Promise<number>;
}
