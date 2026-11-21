CREATE TABLE `delivery_issues` (
	`id` text PRIMARY KEY,
	`alias_id` text NOT NULL,
	`kind` text NOT NULL,
	`destination` text NOT NULL,
	`sender` text DEFAULT '' NOT NULL,
	`subject` text DEFAULT '' NOT NULL,
	`reason` text NOT NULL,
	`reported_at` integer,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_delivery_issues_alias_id_aliases_id_fk` FOREIGN KEY (`alias_id`) REFERENCES `aliases`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `delivery_issues_alias` ON `delivery_issues` (`alias_id`);--> statement-breakpoint
CREATE INDEX `delivery_issues_created` ON `delivery_issues` (`created_at`);--> statement-breakpoint
CREATE INDEX `delivery_issues_unreported` ON `delivery_issues` (`destination`,`created_at`) WHERE "delivery_issues"."reported_at" IS NULL;