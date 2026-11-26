CREATE TYPE "public"."conversation_mode" AS ENUM('auto', 'draft', 'off');--> statement-breakpoint
CREATE TYPE "public"."conversation_status" AS ENUM('open', 'archived');--> statement-breakpoint
CREATE TYPE "public"."draft_action" AS ENUM('reply', 'no_reply', 'escalate');--> statement-breakpoint
CREATE TYPE "public"."draft_status" AS ENUM('pending', 'sent', 'discarded', 'superseded', 'skipped', 'error');--> statement-breakpoint
CREATE TYPE "public"."message_direction" AS ENUM('inbound', 'outbound');--> statement-breakpoint
CREATE TYPE "public"."message_source" AS ENUM('contact', 'ai_auto', 'ai_approved', 'human', 'external');--> statement-breakpoint
CREATE TYPE "public"."message_status" AS ENUM('received', 'queued', 'sending', 'sent', 'delivered', 'read', 'failed');--> statement-breakpoint
CREATE TABLE "app_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"business_name" text NOT NULL,
	"system_prompt" text NOT NULL,
	"model" text NOT NULL,
	"effort" text NOT NULL,
	"default_mode" "conversation_mode" NOT NULL,
	"auto_send_enabled" boolean NOT NULL,
	"debounce_seconds" integer NOT NULL,
	"history_limit" integer NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wa_id" text NOT NULL,
	"phone" text,
	"profile_name" text,
	"display_name" text,
	"notes" text DEFAULT '' NOT NULL,
	"tags" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contacts_wa_id_unique" UNIQUE("wa_id")
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contact_id" uuid NOT NULL,
	"mode" "conversation_mode",
	"status" "conversation_status" DEFAULT 'open' NOT NULL,
	"needs_attention" boolean DEFAULT false NOT NULL,
	"attention_reason" text,
	"summary" text,
	"intent" text,
	"unread_count" integer DEFAULT 0 NOT NULL,
	"last_message_at" timestamp with time zone,
	"last_message_preview" text,
	"last_inbound_at" timestamp with time zone,
	"pending_reply_at" timestamp with time zone,
	"pending_reply_manual" boolean DEFAULT false NOT NULL,
	"reply_generating_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversations_contact_id_unique" UNIQUE("contact_id")
);
--> statement-breakpoint
CREATE TABLE "drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"trigger_message_id" uuid,
	"status" "draft_status" DEFAULT 'pending' NOT NULL,
	"action" "draft_action",
	"body" text DEFAULT '' NOT NULL,
	"original_body" text DEFAULT '' NOT NULL,
	"operator_note" text,
	"intent" text,
	"urgency" text,
	"model" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"cache_read_tokens" integer,
	"latency_ms" integer,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"direction" "message_direction" NOT NULL,
	"source" "message_source" NOT NULL,
	"status" "message_status" NOT NULL,
	"type" text DEFAULT 'text' NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"meta" jsonb,
	"wa_message_id" text,
	"error" text,
	"draft_id" uuid,
	"author" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_wa_message_id_unique" UNIQUE("wa_message_id")
);
--> statement-breakpoint
CREATE TABLE "wa_auth_state" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "worker_status" (
	"id" text PRIMARY KEY NOT NULL,
	"transport" text NOT NULL,
	"state" text NOT NULL,
	"detail" text,
	"qr" text,
	"account" text,
	"version" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversations_last_message_at_idx" ON "conversations" USING btree ("last_message_at");--> statement-breakpoint
CREATE INDEX "conversations_pending_reply_at_idx" ON "conversations" USING btree ("pending_reply_at") WHERE "conversations"."pending_reply_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "drafts_conversation_idx" ON "drafts" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "messages_conversation_created_idx" ON "messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "messages_outbox_idx" ON "messages" USING btree ("created_at") WHERE "messages"."status" = 'queued';