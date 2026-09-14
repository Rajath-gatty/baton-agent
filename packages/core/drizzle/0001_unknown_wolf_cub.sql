CREATE TABLE "worker_state" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"telegram_offset" bigint,
	"last_sweep_fingerprint" text,
	"last_sweep_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "worker_state_single_row" CHECK (id = 1)
);
