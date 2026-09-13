CREATE TYPE "public"."agent_session_status" AS ENUM('open', 'resumed', 'closed');--> statement-breakpoint
CREATE TYPE "public"."agent_task" AS ENUM('ingest', 'assess', 'brief', 'respond', 'resume');--> statement-breakpoint
CREATE TYPE "public"."alias_kind" AS ENUM('handle', 'display_name', 'nickname', 'first_name', 'role_reference');--> statement-breakpoint
CREATE TYPE "public"."asset_kind" AS ENUM('account_login', 'physical_item', 'financial_control', 'relationship', 'document', 'public_presence');--> statement-breakpoint
CREATE TYPE "public"."asset_sensitivity" AS ENUM('normal', 'sensitive');--> statement-breakpoint
CREATE TYPE "public"."asset_status" AS ENUM('active', 'retired');--> statement-breakpoint
CREATE TYPE "public"."brief_kind" AS ENUM('departure', 'arrival');--> statement-breakpoint
CREATE TYPE "public"."brief_section" AS ENUM('only_they_held', 'they_had_promised', 'nobody_else_seen');--> statement-breakpoint
CREATE TYPE "public"."commitment_status" AS ENUM('open', 'completed', 'abandoned');--> statement-breakpoint
CREATE TYPE "public"."consequence_level" AS ENUM('low', 'high');--> statement-breakpoint
CREATE TYPE "public"."curator_classification" AS ENUM('durable_fact', 'commitment', 'participation_evidence', 'lifecycle_event', 'noise');--> statement-breakpoint
CREATE TYPE "public"."fact_status" AS ENUM('active', 'superseded', 'retired', 'unverified', 'pending_approval');--> statement-breakpoint
CREATE TYPE "public"."finding_severity" AS ENUM('low', 'medium', 'high');--> statement-breakpoint
CREATE TYPE "public"."finding_status" AS ENUM('open', 'resolved', 'dismissed');--> statement-breakpoint
CREATE TYPE "public"."finding_subtype" AS ENUM('sole_holder', 'no_owner', 'not_ours', 'loose_end');--> statement-breakpoint
CREATE TYPE "public"."finding_type" AS ENUM('asset', 'capability', 'commitment');--> statement-breakpoint
CREATE TYPE "public"."holding_status" AS ENUM('active', 'released');--> statement-breakpoint
CREATE TYPE "public"."media_kind" AS ENUM('photo', 'voice', 'audio', 'video', 'document', 'sticker', 'other');--> statement-breakpoint
CREATE TYPE "public"."message_source" AS ENUM('telegram', 'seed');--> statement-breakpoint
CREATE TYPE "public"."pending_change_status" AS ENUM('pending', 'applied', 'rejected', 'obsolete');--> statement-breakpoint
CREATE TYPE "public"."person_status" AS ENUM('member', 'left', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."prefilter_verdict" AS ENUM('candidate', 'discarded');--> statement-breakpoint
CREATE TYPE "public"."question_kind" AS ENUM('verification', 'clarification', 'approval');--> statement-breakpoint
CREATE TYPE "public"."question_status" AS ENUM('queued', 'asked', 'resolved', 'obsolete');--> statement-breakpoint
CREATE TYPE "public"."question_target" AS ENUM('group', 'coordinator');--> statement-breakpoint
CREATE TYPE "public"."quiet_decision_scope" AS ENUM('finding', 'brief_line', 'answer');--> statement-breakpoint
CREATE TYPE "public"."run_kind" AS ENUM('backfill', 'ingest', 'sweep', 'brief', 'respond', 'resume');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('running', 'complete', 'interrupted', 'failed');--> statement-breakpoint
CREATE TABLE "agent_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task" "agent_task" NOT NULL,
	"strands_session_id" text,
	"snapshot" jsonb NOT NULL,
	"run_id" uuid,
	"status" "agent_session_status" DEFAULT 'open' NOT NULL,
	"resumed_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_settings" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"chat_id" bigint,
	"org_name" text,
	"timezone" text DEFAULT 'Asia/Kolkata' NOT NULL,
	"coordinator_person_id" uuid,
	"introduced_chat_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_settings_single_row" CHECK (id = 1)
);
--> statement-breakpoint
CREATE TABLE "assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "asset_kind" NOT NULL,
	"name" text NOT NULL,
	"normalised_key" text NOT NULL,
	"sensitivity" "asset_sensitivity" DEFAULT 'normal' NOT NULL,
	"status" "asset_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "brief_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"brief_id" uuid NOT NULL,
	"section" "brief_section" NOT NULL,
	"position" integer NOT NULL,
	"text" text NOT NULL,
	"evidence_fact_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"evidence_message_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"subject_asset_id" uuid,
	"subject_capability_id" uuid,
	"subject_commitment_id" uuid,
	"assigned_to_person_id" uuid,
	"assigned_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "briefs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "brief_kind" NOT NULL,
	"subject_person_id" uuid NOT NULL,
	"run_id" uuid,
	"triggered_by_message_id" uuid,
	"opening_line" text NOT NULL,
	"is_empty" boolean DEFAULT false NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "capabilities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"normalised_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "capability_coverage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"capability_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"first_observed_at" timestamp with time zone NOT NULL,
	"last_observed_at" timestamp with time zone NOT NULL,
	"evidence_message_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "commitments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"substance" text NOT NULL,
	"owner_person_id" uuid,
	"promised_at" timestamp with time zone NOT NULL,
	"deadline" timestamp with time zone,
	"source_message_id" uuid NOT NULL,
	"completion_evidence_message_id" uuid,
	"status" "commitment_status" DEFAULT 'open' NOT NULL,
	"asked_once_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "coordinator_state" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"last_seen_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "coordinator_state_single_row" CHECK (id = 1)
);
--> statement-breakpoint
CREATE TABLE "curator_cache" (
	"content_hash" text NOT NULL,
	"prompt_version" integer NOT NULL,
	"result" jsonb NOT NULL,
	"classification" "curator_classification" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "curator_cache_pkey" PRIMARY KEY("content_hash","prompt_version")
);
--> statement-breakpoint
CREATE TABLE "facts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_id" uuid,
	"claim" text NOT NULL,
	"match_key" text NOT NULL,
	"confidence" real NOT NULL,
	"status" "fact_status" DEFAULT 'active' NOT NULL,
	"sensitivity" "asset_sensitivity" DEFAULT 'normal' NOT NULL,
	"source_message_id" uuid NOT NULL,
	"stated_by_person_id" uuid,
	"stated_at" timestamp with time zone NOT NULL,
	"last_confirmed_at" timestamp with time zone NOT NULL,
	"evidence_message_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"supersedes_fact_id" uuid,
	"curator_reasoning" text,
	"retired_at" timestamp with time zone,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" "finding_type" NOT NULL,
	"subtype" "finding_subtype" NOT NULL,
	"dedupe_key" text NOT NULL,
	"title" text NOT NULL,
	"why_it_matters" text NOT NULL,
	"severity" "finding_severity" NOT NULL,
	"confidence" real NOT NULL,
	"status" "finding_status" DEFAULT 'open' NOT NULL,
	"subject_asset_id" uuid,
	"subject_capability_id" uuid,
	"subject_commitment_id" uuid,
	"holder_person_id" uuid,
	"evidence_fact_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"evidence_message_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"assessor_reasoning" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dismissal_reason" text,
	"dismissed_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"last_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "holdings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_id" uuid NOT NULL,
	"holder_person_id" uuid,
	"holder_external" text,
	"is_personal_resource" boolean DEFAULT false NOT NULL,
	"acquired_at" timestamp with time zone,
	"released_at" timestamp with time zone,
	"status" "holding_status" DEFAULT 'active' NOT NULL,
	"evidence_fact_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" "message_source" NOT NULL,
	"chat_id" bigint NOT NULL,
	"telegram_message_id" bigint NOT NULL,
	"sender_person_id" uuid,
	"sender_telegram_user_id" bigint,
	"sender_display_name" text,
	"sent_at" timestamp with time zone NOT NULL,
	"text" text,
	"content_hash" text NOT NULL,
	"reply_to_telegram_message_id" bigint,
	"reply_to_message_id" uuid,
	"is_forwarded" boolean DEFAULT false NOT NULL,
	"forwarded_from" text,
	"is_edited" boolean DEFAULT false NOT NULL,
	"edited_at" timestamp with time zone,
	"is_withdrawn" boolean DEFAULT false NOT NULL,
	"withdrawn_at" timestamp with time zone,
	"is_unprocessed" boolean DEFAULT false NOT NULL,
	"media_kind" "media_kind",
	"prefilter_verdict" "prefilter_verdict",
	"prefilter_version" integer,
	"curated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pending_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"proposed_change" jsonb NOT NULL,
	"consequence" "consequence_level" NOT NULL,
	"status" "pending_change_status" DEFAULT 'pending' NOT NULL,
	"asset_id" uuid,
	"fact_id" uuid,
	"agent_session_id" uuid,
	"superseded_by_id" uuid,
	"applied_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "people" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"telegram_user_id" bigint,
	"display_name" text NOT NULL,
	"status" "person_status" DEFAULT 'unknown' NOT NULL,
	"joined_at" timestamp with time zone,
	"left_at" timestamp with time zone,
	"private_chat_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "person_aliases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"person_id" uuid NOT NULL,
	"alias" text NOT NULL,
	"normalised_alias" text NOT NULL,
	"kind" "alias_kind" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "question_kind" NOT NULL,
	"target" "question_target" DEFAULT 'group' NOT NULL,
	"target_person_id" uuid,
	"asked_text" text NOT NULL,
	"bot_telegram_message_id" bigint,
	"status" "question_status" DEFAULT 'queued' NOT NULL,
	"asked_at" timestamp with time zone,
	"answer_text" text,
	"answered_by_person_id" uuid,
	"answered_at" timestamp with time zone,
	"resolution" text,
	"resolved_at" timestamp with time zone,
	"interrupt_id" text,
	"interrupt_name" text,
	"pending_change_id" uuid,
	"fact_id" uuid,
	"asset_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quiet_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope" "quiet_decision_scope" NOT NULL,
	"withheld" text NOT NULL,
	"reason" text NOT NULL,
	"run_id" uuid,
	"finding_dedupe_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "run_kind" NOT NULL,
	"status" "run_status" DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"messages_read" integer DEFAULT 0 NOT NULL,
	"candidates" integer DEFAULT 0 NOT NULL,
	"facts_extracted" integer DEFAULT 0 NOT NULL,
	"candidates_skipped" integer DEFAULT 0 NOT NULL,
	"findings_produced" integer DEFAULT 0 NOT NULL,
	"trace" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_sessions" ADD CONSTRAINT "agent_sessions_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_settings" ADD CONSTRAINT "app_settings_coordinator_person_id_people_id_fk" FOREIGN KEY ("coordinator_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brief_lines" ADD CONSTRAINT "brief_lines_brief_id_briefs_id_fk" FOREIGN KEY ("brief_id") REFERENCES "public"."briefs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brief_lines" ADD CONSTRAINT "brief_lines_subject_asset_id_assets_id_fk" FOREIGN KEY ("subject_asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brief_lines" ADD CONSTRAINT "brief_lines_subject_capability_id_capabilities_id_fk" FOREIGN KEY ("subject_capability_id") REFERENCES "public"."capabilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brief_lines" ADD CONSTRAINT "brief_lines_subject_commitment_id_commitments_id_fk" FOREIGN KEY ("subject_commitment_id") REFERENCES "public"."commitments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brief_lines" ADD CONSTRAINT "brief_lines_assigned_to_person_id_people_id_fk" FOREIGN KEY ("assigned_to_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "briefs" ADD CONSTRAINT "briefs_subject_person_id_people_id_fk" FOREIGN KEY ("subject_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "briefs" ADD CONSTRAINT "briefs_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "briefs" ADD CONSTRAINT "briefs_triggered_by_message_id_messages_id_fk" FOREIGN KEY ("triggered_by_message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capability_coverage" ADD CONSTRAINT "capability_coverage_capability_id_capabilities_id_fk" FOREIGN KEY ("capability_id") REFERENCES "public"."capabilities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capability_coverage" ADD CONSTRAINT "capability_coverage_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commitments" ADD CONSTRAINT "commitments_owner_person_id_people_id_fk" FOREIGN KEY ("owner_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commitments" ADD CONSTRAINT "commitments_source_message_id_messages_id_fk" FOREIGN KEY ("source_message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commitments" ADD CONSTRAINT "commitments_completion_evidence_message_id_messages_id_fk" FOREIGN KEY ("completion_evidence_message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facts" ADD CONSTRAINT "facts_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facts" ADD CONSTRAINT "facts_source_message_id_messages_id_fk" FOREIGN KEY ("source_message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facts" ADD CONSTRAINT "facts_stated_by_person_id_people_id_fk" FOREIGN KEY ("stated_by_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facts" ADD CONSTRAINT "facts_supersedes_fact_id_facts_id_fk" FOREIGN KEY ("supersedes_fact_id") REFERENCES "public"."facts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_subject_asset_id_assets_id_fk" FOREIGN KEY ("subject_asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_subject_capability_id_capabilities_id_fk" FOREIGN KEY ("subject_capability_id") REFERENCES "public"."capabilities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_subject_commitment_id_commitments_id_fk" FOREIGN KEY ("subject_commitment_id") REFERENCES "public"."commitments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_holder_person_id_people_id_fk" FOREIGN KEY ("holder_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_last_run_id_runs_id_fk" FOREIGN KEY ("last_run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holdings" ADD CONSTRAINT "holdings_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holdings" ADD CONSTRAINT "holdings_holder_person_id_people_id_fk" FOREIGN KEY ("holder_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "holdings" ADD CONSTRAINT "holdings_evidence_fact_id_facts_id_fk" FOREIGN KEY ("evidence_fact_id") REFERENCES "public"."facts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_person_id_people_id_fk" FOREIGN KEY ("sender_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_reply_to_message_id_messages_id_fk" FOREIGN KEY ("reply_to_message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_changes" ADD CONSTRAINT "pending_changes_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_changes" ADD CONSTRAINT "pending_changes_fact_id_facts_id_fk" FOREIGN KEY ("fact_id") REFERENCES "public"."facts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_changes" ADD CONSTRAINT "pending_changes_agent_session_id_agent_sessions_id_fk" FOREIGN KEY ("agent_session_id") REFERENCES "public"."agent_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_changes" ADD CONSTRAINT "pending_changes_superseded_by_id_pending_changes_id_fk" FOREIGN KEY ("superseded_by_id") REFERENCES "public"."pending_changes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_aliases" ADD CONSTRAINT "person_aliases_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_target_person_id_people_id_fk" FOREIGN KEY ("target_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_answered_by_person_id_people_id_fk" FOREIGN KEY ("answered_by_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_pending_change_id_pending_changes_id_fk" FOREIGN KEY ("pending_change_id") REFERENCES "public"."pending_changes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_fact_id_facts_id_fk" FOREIGN KEY ("fact_id") REFERENCES "public"."facts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quiet_decisions" ADD CONSTRAINT "quiet_decisions_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "assets_kind_normalised_key_key" ON "assets" USING btree ("kind","normalised_key");--> statement-breakpoint
CREATE UNIQUE INDEX "brief_lines_brief_section_position_key" ON "brief_lines" USING btree ("brief_id","section","position");--> statement-breakpoint
CREATE UNIQUE INDEX "capabilities_normalised_key_key" ON "capabilities" USING btree ("normalised_key");--> statement-breakpoint
CREATE UNIQUE INDEX "capability_coverage_capability_person_key" ON "capability_coverage" USING btree ("capability_id","person_id");--> statement-breakpoint
CREATE INDEX "commitments_status_deadline_idx" ON "commitments" USING btree ("status","deadline");--> statement-breakpoint
CREATE INDEX "facts_asset_id_status_idx" ON "facts" USING btree ("asset_id","status");--> statement-breakpoint
CREATE INDEX "facts_match_key_status_idx" ON "facts" USING btree ("match_key","status");--> statement-breakpoint
CREATE UNIQUE INDEX "findings_dedupe_key_key" ON "findings" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "findings_status_severity_idx" ON "findings" USING btree ("status","severity" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "holdings_asset_id_status_idx" ON "holdings" USING btree ("asset_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_chat_id_telegram_message_id_key" ON "messages" USING btree ("chat_id","telegram_message_id");--> statement-breakpoint
CREATE INDEX "messages_prefilter_verdict_curated_at_idx" ON "messages" USING btree ("prefilter_verdict","curated_at");--> statement-breakpoint
CREATE INDEX "messages_sent_at_idx" ON "messages" USING btree ("sent_at");--> statement-breakpoint
CREATE INDEX "pending_changes_status_asset_id_idx" ON "pending_changes" USING btree ("status","asset_id");--> statement-breakpoint
CREATE UNIQUE INDEX "people_telegram_user_id_key" ON "people" USING btree ("telegram_user_id");--> statement-breakpoint
CREATE INDEX "person_aliases_normalised_alias_idx" ON "person_aliases" USING btree ("normalised_alias");--> statement-breakpoint
CREATE UNIQUE INDEX "person_aliases_person_alias_kind_key" ON "person_aliases" USING btree ("person_id","normalised_alias","kind");--> statement-breakpoint
CREATE INDEX "questions_status_asked_at_idx" ON "questions" USING btree ("status","asked_at");--> statement-breakpoint
CREATE INDEX "questions_bot_telegram_message_id_idx" ON "questions" USING btree ("bot_telegram_message_id");--> statement-breakpoint
CREATE INDEX "quiet_decisions_created_at_idx" ON "quiet_decisions" USING btree ("created_at");