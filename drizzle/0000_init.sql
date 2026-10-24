CREATE TABLE "admins" (
	"uid" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"role" text DEFAULT 'coordinator' NOT NULL,
	"region" text,
	"status" text DEFAULT 'Active' NOT NULL,
	"phone" text,
	"organization" text,
	"designation" text,
	"chapter" text,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"legacy" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "attendance" (
	"id" text PRIMARY KEY NOT NULL,
	"conclave_id" text NOT NULL,
	"user_id" text NOT NULL,
	"round_number" integer NOT NULL,
	"table_number" integer,
	"captain_mark" jsonb,
	"self_mark" jsonb,
	"is_present" boolean NOT NULL,
	"source" text NOT NULL,
	"marked_by" text,
	"marked_at" timestamp with time zone,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conclaves" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"venue_location" text DEFAULT '' NOT NULL,
	"region" text,
	"coordinator" text,
	"creator" text,
	"theme" text,
	"date_range" text,
	"start_date" timestamp with time zone,
	"end_date" timestamp with time zone,
	"start_time" text,
	"end_time" text,
	"reg_start_date" timestamp with time zone,
	"reg_end_date" timestamp with time zone,
	"reg_start_time" text,
	"reg_end_time" text,
	"registration_override" text DEFAULT 'auto' NOT NULL,
	"is_registration_open" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'registrationNotOpen' NOT NULL,
	"member_limit" integer,
	"captain_limit" integer,
	"registration_fee" numeric,
	"payment_details" jsonb,
	"chief_guests" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"agenda_document" jsonb,
	"allow_admin_add_members" boolean DEFAULT false NOT NULL,
	"persons_per_table" integer,
	"round_count" integer,
	"seed" bigint,
	"schedule" jsonb,
	"participants" jsonb,
	"schedule_summary" jsonb,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"snapshot" jsonb,
	"is_schedule_locked" boolean DEFAULT false NOT NULL,
	"current_round" integer DEFAULT 0 NOT NULL,
	"current_round_started_at" timestamp with time zone,
	"is_round_paused" boolean DEFAULT false NOT NULL,
	"round_paused_at" timestamp with time zone,
	"round_elapsed_ms_before_pause" bigint,
	"started_by" text,
	"completed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"legacy" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feedback" (
	"conclave_id" text NOT NULL,
	"user_id" text NOT NULL,
	"rating" integer NOT NULL,
	"timing" text,
	"referrals" integer,
	"comment" text DEFAULT '' NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feedback_conclave_id_user_id_pk" PRIMARY KEY("conclave_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"user_id" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"type" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"read" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "one_to_ones" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"from_user_id" text NOT NULL,
	"to_user_id" text NOT NULL,
	"proposed_at" timestamp with time zone NOT NULL,
	"location" text DEFAULT '' NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reminder_sent" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"payment_id" text PRIMARY KEY NOT NULL,
	"order_id" text,
	"conclave_id" text,
	"uid" text,
	"amount" numeric,
	"currency" text DEFAULT 'INR' NOT NULL,
	"status" text NOT NULL,
	"method" text,
	"email" text,
	"contact" text,
	"error_description" text,
	"last_event" text,
	"refunded_amount" numeric,
	"refund_id" text,
	"refunded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "referrals" (
	"id" text PRIMARY KEY NOT NULL,
	"conclave_id" text NOT NULL,
	"from_user_id" text NOT NULL,
	"to_user_id" text NOT NULL,
	"from_name" text,
	"to_name" text,
	"round_number" integer NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'Pending' NOT NULL,
	"outcome" text,
	"outcome_note" text,
	"outcome_at" timestamp with time zone,
	"closed_amount" numeric,
	"created_at" timestamp with time zone,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "regions" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'Active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "registrations" (
	"conclave_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"status" text,
	"participant_id" integer,
	"table_number" integer,
	"name" text,
	"email" text,
	"phone" text,
	"company" text,
	"category" text,
	"chapter" text,
	"region" text,
	"state" text,
	"country" text,
	"meal_preference" text,
	"needs_accommodation" text,
	"payment_status" text,
	"amount_paid" numeric,
	"payment" jsonb,
	"added_by" jsonb,
	"registered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"legacy" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "registrations_conclave_id_user_id_pk" PRIMARY KEY("conclave_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"uid" text PRIMARY KEY NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"email" text,
	"auth_email" text,
	"phone" text,
	"company" text,
	"category" text,
	"chapter" text,
	"region" text,
	"state" text,
	"country" text,
	"location" text,
	"designation" text,
	"membership" text,
	"photo_url" text,
	"can_offer" text,
	"looking_for" text,
	"role" text DEFAULT 'member' NOT NULL,
	"is_captain" boolean DEFAULT false NOT NULL,
	"status" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"default_password_assigned" boolean DEFAULT false NOT NULL,
	"last_login_at" timestamp with time zone,
	"last_active_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"legacy" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attendance" ADD CONSTRAINT "attendance_conclave_id_conclaves_id_fk" FOREIGN KEY ("conclave_id") REFERENCES "public"."conclaves"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_conclave_id_conclaves_id_fk" FOREIGN KEY ("conclave_id") REFERENCES "public"."conclaves"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_uid_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("uid") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_conclave_id_conclaves_id_fk" FOREIGN KEY ("conclave_id") REFERENCES "public"."conclaves"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registrations" ADD CONSTRAINT "registrations_conclave_id_conclaves_id_fk" FOREIGN KEY ("conclave_id") REFERENCES "public"."conclaves"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "admins_email_uq" ON "admins" USING btree (lower("email"));--> statement-breakpoint
CREATE INDEX "attendance_conclave_round_idx" ON "attendance" USING btree ("conclave_id","round_number");--> statement-breakpoint
CREATE INDEX "conclaves_status_idx" ON "conclaves" USING btree ("status");--> statement-breakpoint
CREATE INDEX "conclaves_start_idx" ON "conclaves" USING btree ("start_date");--> statement-breakpoint
CREATE INDEX "notifications_user_created_idx" ON "notifications" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "one_to_ones_from_idx" ON "one_to_ones" USING btree ("from_user_id");--> statement-breakpoint
CREATE INDEX "one_to_ones_to_idx" ON "one_to_ones" USING btree ("to_user_id");--> statement-breakpoint
CREATE INDEX "one_to_ones_reminder_idx" ON "one_to_ones" USING btree ("status","reminder_sent","proposed_at");--> statement-breakpoint
CREATE INDEX "payments_conclave_idx" ON "payments" USING btree ("conclave_id");--> statement-breakpoint
CREATE INDEX "referrals_conclave_idx" ON "referrals" USING btree ("conclave_id");--> statement-breakpoint
CREATE INDEX "referrals_to_idx" ON "referrals" USING btree ("to_user_id");--> statement-breakpoint
CREATE INDEX "referrals_from_idx" ON "referrals" USING btree ("from_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "regions_name_uq" ON "regions" USING btree (lower("name"));--> statement-breakpoint
CREATE INDEX "registrations_user_idx" ON "registrations" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "users_phone_idx" ON "users" USING btree ("phone");--> statement-breakpoint
CREATE INDEX "users_email_idx" ON "users" USING btree ("email");