-- Minimal tasks table so attachments have something to reference.
-- If a real Tasks table already exists elsewhere in your system, skip this file.
CREATE TABLE IF NOT EXISTS tasks (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
