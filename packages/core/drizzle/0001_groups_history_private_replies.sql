CREATE TYPE "public"."contact_kind" AS ENUM('person', 'group');--> statement-breakpoint
CREATE TYPE "public"."reply_target" AS ENUM('chat', 'sender');--> statement-breakpoint
ALTER TABLE "app_settings" ADD COLUMN "auto_track_new_groups" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "app_settings" ADD COLUMN "group_default_mode" "conversation_mode" DEFAULT 'auto' NOT NULL;--> statement-breakpoint
ALTER TABLE "app_settings" ADD COLUMN "group_reply_target" "reply_target" DEFAULT 'sender' NOT NULL;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "kind" "contact_kind" DEFAULT 'person' NOT NULL;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "tracked" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "participants" jsonb;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "reply_target" "reply_target" DEFAULT 'chat' NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "pending_context_id" uuid;--> statement-breakpoint
ALTER TABLE "drafts" ADD COLUMN "context_conversation_id" uuid;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "sender_contact_id" uuid;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "sender_name" text;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_contact_id_contacts_id_fk" FOREIGN KEY ("sender_contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;