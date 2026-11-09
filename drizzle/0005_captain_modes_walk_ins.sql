ALTER TABLE "conclaves" ADD COLUMN "captain_mode" text DEFAULT 'required' NOT NULL;--> statement-breakpoint
ALTER TABLE "conclaves" ADD COLUMN "stand_in_captains" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "registrations" ADD COLUMN "is_walk_in" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "registrations" ADD COLUMN "walk_in_status" text;--> statement-breakpoint
ALTER TABLE "registrations" ADD COLUMN "joins_from_round" integer;