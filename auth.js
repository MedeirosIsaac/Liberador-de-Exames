/**
 * Autenticação
 * ------------
 * - Senhas: scrypt (nativo do Node) com salt aleatório — a senha em si nunca
 *   é guardada.
 * - Sessões: token aleatório de 256 bits no cookie (httpOnly); no banco fica
 *   só o SHA-256 do token, então um vazamento do banco não entrega sessões
 *   válidas. Dá pra encerrar qualquer sessão no servidor (logout, usuário
 *   desativado, troca de senha).
 * - Força bruta: 5 erros seguidos bloqueiam a conta por 15 min (além do limite
 *   por IP configurado no server.js).
 */
const crypto = require("crypto");
const { promisify } = require("util");
const db = require("./db");

const scrypt = promisify(crypto.scrypt);

const SCRYPT = { N: 2 ** 15, r: 8, p: 1, keylen: 64 };
const NOME_COOKIE = "sid";
const SESSAO_HORAS = Number(process.env.SESSAO_HORAS) || 12;
const MAX_FALHAS = 5;
const BLOQUEIO_MINUTOS = 15;
const SENHA_MIN = 10;
const SENHA_MAX = 200;

// ---------------------------------------------------------------- senhas ----

function memoriaScrypt(N, r) {
  return 128 * N * r * 2; // o Node recusa se o limite de memória for justo demais
}

async function hashSenha(senha) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(senha, salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: memoriaScrypt(SCRYPT.N, SCRYPT.r),
  });
  return [
    "scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p,
    salt.toString("base64"), hash.toString("base64"),
  ].join("$");
}

async function verificarSenha(senha, armazenado) {
  const partes = String(armazenado).split("$");
  if (partes.length !== 6 || partes[0] !== "scrypt") return false;
  const N = Number(partes[1]);
  const r = Number(partes[2]);
  const p = Number(partes[3]);
  const salt = Buffer.from(partes[4], "base64");
  const esperado = Buffer.from(partes[5], "base64");
  const obtido = await scrypt(senha, salt, esperado.length, {
    N, r, p, maxmem: memoriaScrypt(N, r),
  });
  return obtido.length === esperado.length && crypto.timingSafeEqual(obtido, esperado);
}

// Usado quando o e-mail não existe: gasta o mesmo tempo de uma verificação
// real, para o tempo de resposta não revelar quais e-mails estão cadastrados.
const HASH_FALSO = hashSenha(crypto.randomBytes(16).toString("hex"));

function validarSenhaNova(senha) {
  if (typeof senha !== "string" || senha.length < SENHA_MIN) {
    return `A senha precisa ter pelo menos ${SENHA_MIN} caracteres.`;
  }
  if (senha.length > SENHA_MAX) return `A senha pode ter no máximo ${SENHA_MAX} caracteres.`;
  return null;
}

// -------------------------------------------------------------- usuários ----

function normalizarEmail(email) {
  return String(email || "").trim().toLowerCase();
}

async function criarUsuario({ email, nome, senha, papel = "operador" }) {
  email = normalizarEmail(email);
  nome = String(nome || "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    throw new Error("E-mail inválido.");
  }
  if (!nome || nome.length > 120) throw new Error("Informe o nome (até 120 caracteres).");
  if (!["admin", "operador"].includes(papel)) throw new Error("Papel deve ser 'admin' ou 'operador'.");
  const erroSenha = validarSenhaNova(senha);
  if (erroSenha) throw new Error(erroSenha);

  const senhaHash = await hashSenha(senha);
  try {
    await db.query(
      `INSERT INTO usuarios (id, email, nome, senha_hash, papel) VALUES ($1, $2, $3, $4, $5)`,
      [crypto.randomUUID(), email, nome, senhaHash, papel]
    );
  } catch (err) {
    if (err.code === "23505") throw new Error(`Já existe um usuário com o e-mail ${email}.`);
    throw err;
  }
}

async function buscarUsuarioPorEmail(email) {
  const { rows } = await db.query(`SELECT * FROM usuarios WHERE email = $1`, [normalizarEmail(email)]);
  return rows[0] || null;
}

async function registrarFalha(usuarioId) {
  await db.query(
    `UPDATE usuarios SET
       bloqueado_ate = CASE WHEN tentativas_falhas + 1 >= $2::int
                            THEN now() + ($3::int * interval '1 minute')
                            ELSE bloqueado_ate END,
       tentativas_falhas = CASE WHEN tentativas_falhas + 1 >= $2::int
                                THEN 0 ELSE tentativas_falhas + 1 END
     WHERE id = $1`,
    [usuarioId, MAX_FALHAS, BLOQUEIO_MINUTOS]
  );
}

async function zerarFalhas(usuarioId) {
  await db.query(
    `UPDATE usuarios SET tentativas_falhas = 0, bloqueado_ate = NULL WHERE id = $1`,
    [usuarioId]
  );
}

function estaBloqueado(usuario) {
  return Boolean(usuario.bloqueado_ate) && new Date(usuario.bloqueado_ate) > new Date();
}

async function garantirAdminInicial() {
  const { rows } = await db.query(`SELECT count(*)::int AS n FROM usuarios`);
  if (rows[0].n > 0) return;

  const { ADMIN_EMAIL, ADMIN_NOME, ADMIN_SENHA } = process.env;
  if (!ADMIN_EMAIL || !ADMIN_SENHA) {
    console.warn(
      "[auth] Nenhum usuário cadastrado. Defina ADMIN_EMAIL e ADMIN_SENHA (primeiro start) " +
        "ou rode: npm run usuarios -- criar <email> \"<nome>\" admin"
    );
    return;
  }
  try {
    await criarUsuario({
      email: ADMIN_EMAIL,
      nome: ADMIN_NOME || "Administrador",
      senha: ADMIN_SENHA,
      papel: "admin",
    });
    console.log(`[auth] Administrador inicial criado (${ADMIN_EMAIL}). Remova ADMIN_SENHA das variáveis de ambiente.`);
  } catch (err) {
    console.error("[auth] Não foi possível criar o administrador inicial:", err.message);
  }
}

// --------------------------------------------------------------- sessões ----

function sha256(texto) {
  return crypto.createHash("sha256").update(texto).digest("hex");
}

function lerCookie(req, nome) {
  const cabecalho = req.headers.cookie;
  if (!cabecalho) return null;
  for (const parte of cabecalho.split(";")) {
    const i = parte.indexOf("=");
    if (i < 0) continue;
    if (parte.slice(0, i).trim() !== nome) continue;
    try {
      return decodeURIComponent(parte.slice(i + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

async function criarSessao(usuarioId, req) {
  const token = crypto.randomBytes(32).toString("base64url");
  const expira = new Date(Date.now() + SESSAO_HORAS * 3600 * 1000);
  await db.query(
    `INSERT INTO sessoes (token_hash, usuario_id, expira_em, ip, user_agent)
     VALUES ($1, $2, $3, $4, $5)`,
    [sha256(token), usuarioId, expira, req.ip, String(req.get("user-agent") || "").slice(0, 300)]
  );
  return token;
}

async function usuarioDaSessao(req) {
  const token = lerCookie(req, NOME_COOKIE);
  if (!token || token.length > 200) return null;
  const { rows } = await db.query(
    `SELECT u.id, u.email, u.nome, u.papel
       FROM sessoes s
       JOIN usuarios u ON u.id = s.usuario_id
      WHERE s.token_hash = $1 AND s.expira_em > now() AND u.ativo = TRUE`,
    [sha256(token)]
  );
  return rows[0] || null;
}

async function encerrarSessaoDoRequest(req) {
  const token = lerCookie(req, NOME_COOKIE);
  if (token) await db.query(`DELETE FROM sessoes WHERE token_hash = $1`, [sha256(token)]);
}

async function encerrarSessoesDoUsuario(usuarioId) {
  await db.query(`DELETE FROM sessoes WHERE usuario_id = $1`, [usuarioId]);
}

async function limparSessoesExpiradas() {
  await db.query(`DELETE FROM sessoes WHERE expira_em < now()`);
}

function opcoesCookie(req) {
  return {
    httpOnly: true,       // JavaScript da página não consegue ler o cookie
    sameSite: "lax",      // não é enviado em requisições vindas de outros sites
    secure: req.secure,   // só por HTTPS quando a conexão é HTTPS (Render)
    path: "/",
  };
}

function definirCookieSessao(req, res, token) {
  res.cookie(NOME_COOKIE, token, { ...opcoesCookie(req), maxAge: SESSAO_HORAS * 3600 * 1000 });
}

function limparCookieSessao(req, res) {
  res.clearCookie(NOME_COOKIE, opcoesCookie(req));
}

// ------------------------------------------------------------ middleware ----

// Tudo que vier DEPOIS deste middleware exige login ("negar por padrão").
function exigirLogin(req, res, next) {
  usuarioDaSessao(req)
    .then((usuario) => {
      if (usuario) {
        req.usuario = usuario;
        res.set("Cache-Control", "no-store"); // o botão "voltar" não reabre páginas após o logout
        return next();
      }
      const navegador = req.method === "GET" && (req.headers.accept || "").includes("text/html");
      if (navegador) return res.redirect(302, "/login");
      return res.status(401).json({ erro: "Sessão expirada ou inexistente. Faça login novamente." });
    })
    .catch((err) => {
      console.error("[auth] erro ao validar sessão:", err.message);
      res.status(500).json({ erro: "Erro interno ao validar a sessão." });
    });
}

module.exports = {
  MAX_FALHAS,
  BLOQUEIO_MINUTOS,
  HASH_FALSO,
  hashSenha,
  verificarSenha,
  validarSenhaNova,
  normalizarEmail,
  criarUsuario,
  buscarUsuarioPorEmail,
  registrarFalha,
  zerarFalhas,
  estaBloqueado,
  garantirAdminInicial,
  criarSessao,
  usuarioDaSessao,
  encerrarSessaoDoRequest,
  encerrarSessoesDoUsuario,
  limparSessoesExpiradas,
  definirCookieSessao,
  limparCookieSessao,
  exigirLogin,
};
