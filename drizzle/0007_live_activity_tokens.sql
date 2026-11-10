CREATE TABLE "live_activity_tokens" (
	"conclave_id" text NOT NULL,
	"user_id" text NOT NULL,
	"push_token" text NOT NULL,
	"fcm_token" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "live_activity_tokens_conclave_id_user_id_pk" PRIMARY KEY("conclave_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "conclaves" ADD COLUMN "live_activity_key" text;--> statement-breakpoint
ALTER TABLE "live_activity_tokens" ADD CONSTRAINT "live_activity_tokens_conclave_id_conclaves_id_fk" FOREIGN KEY ("conclave_id") REFERENCES "public"."conclaves"("id") ON DELETE cascade ON UPDATE no action;