ALTER TABLE "conclaves" ADD COLUMN IF NOT EXISTS "round_progression_mode" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "conclaves" ADD COLUMN IF NOT EXISTS "round_duration_minutes" integer DEFAULT 15 NOT NULL;--> statement-breakpoint
ALTER TABLE "conclaves" ADD COLUMN IF NOT EXISTS "round_extension_seconds" integer DEFAULT 0 NOT NULL;