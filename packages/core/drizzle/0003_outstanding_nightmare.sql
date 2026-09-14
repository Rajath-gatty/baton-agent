ALTER TABLE "messages" ADD COLUMN "is_question_to_bot" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "question_answered_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "messages_is_question_to_bot_answered_idx" ON "messages" USING btree ("is_question_to_bot","question_answered_at");