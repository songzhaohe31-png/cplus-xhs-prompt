CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  name TEXT,
  mime TEXT,
  data BYTEA,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY,
  knowledge_id TEXT,
  name TEXT,
  page INT,
  text TEXT,
  meta JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS logs (
  id TEXT PRIMARY KEY,
  kind TEXT,
  user_name TEXT,
  model TEXT,
  status TEXT,
  intent TEXT,
  meta JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
