CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	"request_id" text,
	"actor_uid" text,
	"actor_role" text,
	"actor_email" text,
	"actor_name" text,
	"source" text,
	"ip" text,
	"user_agent" text,
	"action" text NOT NULL,
	"entity_type" text,
	"entity_id" text,
	"conclave_id" text,
	"changes" jsonb,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"method" text,
	"route" text,
	"status_code" integer,
	"outcome" text DEFAULT 'success' NOT NULL,
	"error" text,
	"duration_ms" integer
);
--> statement-breakpoint
CREATE INDEX "audit_occurred_idx" ON "audit_log" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "audit_actor_idx" ON "audit_log" USING btree ("actor_uid","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_entity_idx" ON "audit_log" USING btree ("entity_type","entity_id","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_conclave_idx" ON "audit_log" USING btree ("conclave_id","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_action_idx" ON "audit_log" USING btree ("action","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_request_idx" ON "audit_log" USING btree ("request_id");--> statement-breakpoint
-- The audit trail is append-only: history must not be editable from the app.
-- (A DBA can still drop the trigger deliberately, e.g. for a retention purge.)
CREATE OR REPLACE FUNCTION audit_log_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only (% blocked)', TG_OP;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER audit_log_no_update_delete
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();
--> statement-breakpoint
CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_immutable();
