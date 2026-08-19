const fs = require('fs');
const path = require('path');

async function attachPostgres(opts) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.warn('[db] 未设置 DATABASE_URL。Render 免费磁盘不持久，生产请加 PostgreSQL。当前使用本地 JSON。');
    return { enabled: false };
  }
  let Pool;
  try {
    Pool = require('pg').Pool;
  } catch (e) {
    console.warn('[db] 未安装 pg，跳过 Postgres');
    return { enabled: false };
  }
  const pool = new Pool({
    connectionString: url,
    ssl: /render\.com|amazonaws\.com/.test(url) ? { rejectUnauthorized: false } : undefined
  });
  await pool.query(`
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
  `);

  const { DATA_DIR, writeData } = opts;

  const rows = await pool.query('SELECT key, value FROM kv');
  rows.rows.forEach((row) => {
    const file = path.join(DATA_DIR, row.key);
    try {
      fs.writeFileSync(file, JSON.stringify(row.value, null, 2));
    } catch (e) { /* ignore */ }
  });

  global.__cplusPg = pool;

  return {
    enabled: true,
    pool,
    async saveFile(id, name, mime, buf) {
      await pool.query(
        'INSERT INTO files(id,name,mime,data) VALUES($1,$2,$3,$4) ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, mime=EXCLUDED.mime, data=EXCLUDED.data',
        [id, name, mime, buf]
      );
    },
    async getFile(id) {
      const r = await pool.query('SELECT name, mime, data FROM files WHERE id=$1', [id]);
      return r.rows[0] || null;
    },
    async replaceChunks(knowledgeId, chunks) {
      await pool.query('DELETE FROM chunks WHERE knowledge_id=$1', [knowledgeId]);
      for (const c of chunks) {
        await pool.query(
          'INSERT INTO chunks(id,knowledge_id,name,page,text,meta) VALUES($1,$2,$3,$4,$5,$6)',
          [c.id, knowledgeId, c.name, c.page || 1, c.text, c]
        );
      }
    },
    async log(row) {
      await pool.query(
        'INSERT INTO logs(id,kind,user_name,model,status,intent,meta) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [row.id, row.kind, row.user_name, row.model, row.status, row.intent, row.meta || {}]
      );
    }
  };
}

module.exports = { attachPostgres };
