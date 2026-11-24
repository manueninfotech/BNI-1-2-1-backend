ALTER TABLE "conclaves" ADD COLUMN "cover_image" jsonb;--> statement-breakpoint
ALTER TABLE "conclaves" ADD COLUMN "flyers" jsonb DEFAULT '[]'::jsonb NOT NULL;