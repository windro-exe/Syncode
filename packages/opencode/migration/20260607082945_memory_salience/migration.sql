ALTER TABLE `memory_entry` ADD `importance` integer DEFAULT 5 NOT NULL;--> statement-breakpoint
ALTER TABLE `memory_entry` ADD `reinforcement` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `memory_entry` ADD `last_reinforced` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `memory_entry` ADD `content_hash` text;--> statement-breakpoint
ALTER TABLE `memory_entry` ADD `kind` text DEFAULT 'semantic' NOT NULL;