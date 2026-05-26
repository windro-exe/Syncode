import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core"
import { sql } from "drizzle-orm"
import type { SessionID } from "../session/schema"
import { SessionTable } from "../session/session.sql"
import { Timestamps } from "../storage/schema.sql"

export type MemoryScope = "global" | "session"

export const MemoryEntryTable = sqliteTable(
  "memory_entry",
  {
    id: text().primaryKey(),
    scope: text().$type<MemoryScope>().notNull(),
    session_id: text()
      .$type<SessionID>()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    path: text().notNull(),
    title: text(),
    content: text().notNull(),
    tags: text({ mode: "json" }).$type<string[]>().notNull().default(sql`'[]'`),
    pinned: integer({ mode: "boolean" }).notNull().default(false),
    access_count: integer().notNull().default(0),
    time_accessed: integer().notNull(),
    ...Timestamps,
  },
  (table) => [
    uniqueIndex("memory_entry_scope_session_path_idx").on(
      table.scope,
      sql`COALESCE(${table.session_id},'')`,
      table.path,
    ),
    index("memory_entry_scope_idx").on(table.scope),
    index("memory_entry_session_idx").on(table.session_id),
  ],
)
