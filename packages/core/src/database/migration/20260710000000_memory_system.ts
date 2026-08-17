import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260710000000_memory_system",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE IF NOT EXISTS \`memory_entry\` (
          \`id\` text PRIMARY KEY NOT NULL,
          \`scope\` text NOT NULL,
          \`session_id\` text,
          \`path\` text NOT NULL,
          \`title\` text,
          \`content\` text NOT NULL,
          \`tags\` text DEFAULT '[]' NOT NULL,
          \`pinned\` integer DEFAULT 0 NOT NULL,
          \`access_count\` integer DEFAULT 0 NOT NULL,
          \`time_accessed\` integer NOT NULL,
          \`importance\` integer DEFAULT 5 NOT NULL,
          \`reinforcement\` integer DEFAULT 0 NOT NULL,
          \`last_reinforced\` integer DEFAULT 0 NOT NULL,
          \`content_hash\` text,
          \`kind\` text DEFAULT 'semantic' NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON UPDATE no action ON DELETE cascade
        );
      `)
      yield* tx.run(`
        CREATE UNIQUE INDEX IF NOT EXISTS \`memory_entry_scope_session_path_idx\` ON \`memory_entry\` (\`scope\`, COALESCE(\`session_id\`,''), \`path\`);
      `)
      yield* tx.run(`CREATE INDEX IF NOT EXISTS \`memory_entry_scope_idx\` ON \`memory_entry\` (\`scope\`);`)
      yield* tx.run(`CREATE INDEX IF NOT EXISTS \`memory_entry_session_idx\` ON \`memory_entry\` (\`session_id\`);`)
      yield* tx.run(`
        CREATE VIRTUAL TABLE IF NOT EXISTS \`memory_entry_fts\` USING fts5(
          path,
          title,
          content,
          tags,
          content='memory_entry',
          content_rowid='rowid',
          tokenize='unicode61'
        );
      `)
      yield* tx.run(`
        CREATE TRIGGER IF NOT EXISTS \`memory_entry_ai\` AFTER INSERT ON \`memory_entry\` BEGIN
          INSERT INTO memory_entry_fts(rowid, path, title, content, tags)
          VALUES (new.rowid, new.path, COALESCE(new.title,''), new.content, new.tags);
        END;
      `)
      yield* tx.run(`
        CREATE TRIGGER IF NOT EXISTS \`memory_entry_ad\` AFTER DELETE ON \`memory_entry\` BEGIN
          INSERT INTO memory_entry_fts(memory_entry_fts, rowid, path, title, content, tags)
          VALUES('delete', old.rowid, old.path, COALESCE(old.title,''), old.content, old.tags);
        END;
      `)
      yield* tx.run(`
        CREATE TRIGGER IF NOT EXISTS \`memory_entry_au\` AFTER UPDATE ON \`memory_entry\` BEGIN
          INSERT INTO memory_entry_fts(memory_entry_fts, rowid, path, title, content, tags)
          VALUES('delete', old.rowid, old.path, COALESCE(old.title,''), old.content, old.tags);
          INSERT INTO memory_entry_fts(rowid, path, title, content, tags)
          VALUES (new.rowid, new.path, COALESCE(new.title,''), new.content, new.tags);
        END;
      `)
    })
  },
} satisfies DatabaseMigration.Migration
