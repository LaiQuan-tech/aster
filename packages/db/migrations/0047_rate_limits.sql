CREATE TABLE IF NOT EXISTS "rate_limits" (
	"key" text PRIMARY KEY NOT NULL,
	"last_at" timestamp with time zone DEFAULT now() NOT NULL
);
