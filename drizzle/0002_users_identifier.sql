DROP INDEX "users_email_idx";--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "identifier" text;--> statement-breakpoint
CREATE INDEX "users_identifier_idx" ON "users" USING btree (lower("identifier"));--> statement-breakpoint
CREATE INDEX "users_email_idx" ON "users" USING btree (lower("email"));