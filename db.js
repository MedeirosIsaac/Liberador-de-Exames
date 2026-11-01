/**
 * Conexão com o PostgreSQL.
 *
 * O Render (plano free) apaga o disco a cada deploy/reinício, então usuários e
 * sessões precisam morar num banco externo. A conexão vem da variável
 * DATABASE_URL (ex.: a string de conexão do Neon).
 */
require("dotenv").config({ quiet: true });
const { Pool } = require("pg");

if (!process.env.DATABASE_URL) {
  console.error(
    "DATABASE_URL não definida. Copie .env.example para .env e preencha " +
      "(ou configure a variável no painel do Render)."
  );
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 15_000,
});

// Sem isso, uma conexão derrubada pelo servidor (comum em bancos serverless
// que "dormem") derrubaria o processo inteiro.
pool.on("error", (err) => console.error("[db] erro numa conexão ociosa:", err.message));

// Bancos serverless derrubam conexões ociosas; se a primeira tentativa falhar
// por isso, tenta de novo uma vez numa conexão nova.
async function query(texto, params) {
  try {
    return await pool.query(texto, params);
  } catch (err) {
    if (/Connection terminated|ECONNRESET|EPIPE/i.test(err.message)) {
      return pool.query(texto, params);
    }
    throw err;
  }
}

async function iniciarBanco() {
  await query(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id                TEXT PRIMARY KEY,
      email             TEXT NOT NULL UNIQUE,
      nome              TEXT NOT NULL,
      senha_hash        TEXT NOT NULL,
      papel             TEXT NOT NULL DEFAULT 'operador',
      ativo             BOOLEAN NOT NULL DEFAULT TRUE,
      tentativas_falhas INTEGER NOT NULL DEFAULT 0,
      bloqueado_ate     TIMESTAMPTZ,
      criado_em         TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS sessoes (
      token_hash TEXT PRIMARY KEY,
      usuario_id TEXT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
      criada_em  TIMESTAMPTZ NOT NULL DEFAULT now(),
      expira_em  TIMESTAMPTZ NOT NULL,
      ip         TEXT,
      user_agent TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_sessoes_usuario ON sessoes (usuario_id);
    CREATE INDEX IF NOT EXISTS idx_sessoes_expira  ON sessoes (expira_em);
  `);
}

module.exports = { pool, query, iniciarBanco };
