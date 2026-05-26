CREATE TABLE `memory_entry` (
	`id` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`session_id` text,
	`path` text NOT NULL,
	`title` text,
	`content` text NOT NULL,
	`tags` text DEFAULT '[]' NOT NULL,
	`pinned` integer DEFAULT 0 NOT NULL,
	`access_count` integer DEFAULT 0 NOT NULL,
	`time_accessed` integer NOT NULL,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `memory_entry_scope_session_path_idx` ON `memory_entry` (`scope`, COALESCE(`session_id`,''), `path`);
--> statement-breakpoint
CREATE INDEX `memory_entry_scope_idx` ON `memory_entry` (`scope`);
--> statement-breakpoint
CREATE INDEX `memory_entry_session_idx` ON `memory_entry` (`session_id`);
--> statement-breakpoint
CREATE VIRTUAL TABLE `memory_entry_fts` USING fts5(
	path,
	title,
	content,
	tags,
	content='memory_entry',
	content_rowid='rowid',
	tokenize='unicode61'
);
--> statement-breakpoint
CREATE TRIGGER `memory_entry_ai` AFTER INSERT ON `memory_entry` BEGIN
	INSERT INTO memory_entry_fts(rowid, path, title, content, tags)
	VALUES (new.rowid, new.path, COALESCE(new.title,''), new.content, new.tags);
END;
--> statement-breakpoint
CREATE TRIGGER `memory_entry_ad` AFTER DELETE ON `memory_entry` BEGIN
	INSERT INTO memory_entry_fts(memory_entry_fts, rowid, path, title, content, tags)
	VALUES('delete', old.rowid, old.path, COALESCE(old.title,''), old.content, old.tags);
END;
--> statement-breakpoint
CREATE TRIGGER `memory_entry_au` AFTER UPDATE ON `memory_entry` BEGIN
	INSERT INTO memory_entry_fts(memory_entry_fts, rowid, path, title, content, tags)
	VALUES('delete', old.rowid, old.path, COALESCE(old.title,''), old.content, old.tags);
	INSERT INTO memory_entry_fts(rowid, path, title, content, tags)
	VALUES (new.rowid, new.path, COALESCE(new.title,''), new.content, new.tags);
END;
