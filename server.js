/**
 * Liberação para coleta — API + interface (com login obrigatório)
 * ----------------------------------------------------------------
 * Gera o PDF "Liberação para coleta" a partir do template_original.hbs
 * (Handlebars + HTML/CSS), renderizado por um Chromium headless (Puppeteer).
 *
 * Segurança (etapa 1):
 *  - Tudo exige login, exceto: /login, /auth/login, /logo.png, /login.js e /health.
 *    As rotas novas que você criar depois já nascem protegidas.
 *  - Páginas, lista de exames e emissão de PDF só existem para quem está logado.
 *  - Sessão em cookie httpOnly; senhas com scrypt; bloqueio por tentativas.
 *
 * Rodar localmente:
 *   cp .env.example .env   (e preencher DATABASE_URL)
 *   npm install
 *   npm start
 */

require("dotenv").config({ quiet: true });

const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const fs = require("fs");
const path = require("path");
const handlebars = require("handlebars");
const puppeteer = require("puppeteer");

const db = require("./db");
const auth = require("./auth");

const PUBLICO = path.join(__dirname, "public");   // só o que a tela de login precisa
const PRIVADO = path.join(__dirname, "privado");  // só depois do login

const app = express();

// O Render fica na frente do app (proxy): sem isto o Express enxergaria sempre
// "http" e o IP do proxy, quebrando o cookie "secure" e o limite por IP.
app.set("trust proxy", 1);

app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        "default-src": ["'self'"],
        "script-src": ["'self'"], // sem JavaScript inline: mitiga XSS
        "style-src": ["'self'", "'unsafe-inline'"],
        "img-src": ["'self'", "data:"],
        "connect-src": ["'self'"],
        "font-src": ["'self'"],
        "object-src": ["'none'"],
        "base-uri": ["'self'"],
        "form-action": ["'self'"],
        "frame-ancestors": ["'none'"],
      },
    },
  })
);
app.use(express.json({ limit: "100kb" }));

// ------------------------------------------------------------- template ----

const template = handlebars.compile(
  fs.readFileSync(path.join(__dirname, "template_original.hbs"), "utf8")
);

// A logo mora em public/logo.png. O Chromium headless não carrega file://, então
// lemos o arquivo aqui e entregamos ao template como data URI.
const LOGO_DATA_URI = `data:image/png;base64,${fs
  .readFileSync(path.join(PUBLICO, "logo.png"))
  .toString("base64")}`;

function formatarMoeda(valor) {
  return valor.toFixed(2).replace(".", ",");
}

// Uma instância do navegador reaproveitada entre requisições.
let browserPromise = null;
function getBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer
      .launch({
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      })
      .then((browser) => {
        // Se o Chromium morrer (ex.: falta de memória no plano free), o próximo
        // pedido abre um novo em vez de falhar para sempre.
        browser.on("disconnected", () => {
          browserPromise = null;
        });
        return browser;
      })
      .catch((err) => {
        browserPromise = null;
        throw err;
      });
  }
  return browserPromise;
}

// ------------------------------------------------------------ utilidades ----

const asyncH = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Defesa extra contra CSRF: se o navegador informa a origem de um POST, ela
// precisa ser este mesmo site. (O cookie SameSite=Lax já cobre o caso comum.)
function verificarOrigem(req, res, next) {
  if (req.method === "POST") {
    const origem = req.get("origin");
    if (origem) {
      let host = null;
      try {
        host = new URL(origem).host;
      } catch {
        /* origem inválida */
      }
      if (host !== req.get("host")) return res.status(403).json({ erro: "Origem não permitida." });
    }
  }
  next();
}
app.use(verificarOrigem);

// ---------------------------------------------------- rotas públicas ----

for (const arquivo of ["logo.png", "login.js", "convite.js"]) {
  app.get(`/${arquivo}`, (req, res) => res.sendFile(path.join(PUBLICO, arquivo)));
}

app.get("/health", (req, res) => res.json({ status: "ok" }));

app.get(
  "/login",
  asyncH(async (req, res) => {
    if (await auth.usuarioDaSessao(req)) return res.redirect("/");
    res.set("Cache-Control", "no-store");
    res.sendFile(path.join(PUBLICO, "login.html"));
  })
);

// Só tentativas que FALHAM contam para o limite (login correto não gasta cota).
const limiteLogin = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  skipSuccessfulRequests: true,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { erro: "Muitas tentativas. Aguarde alguns minutos e tente de novo." },
});

const MENSAGEM_LOGIN_INVALIDO =
  "E-mail ou senha inválidos, ou acesso temporariamente bloqueado.";

app.post(
  "/auth/login",
  limiteLogin,
  asyncH(async (req, res) => {
    const email = auth.normalizarEmail(req.body?.email);
    const senha = typeof req.body?.senha === "string" ? req.body.senha : "";

    if (!email || !senha || email.length > 254 || senha.length > 200) {
      return res.status(400).json({ erro: "Informe e-mail e senha." });
    }

    const usuario = await auth.buscarUsuarioPorEmail(email);
    const hashParaComparar = usuario ? usuario.senha_hash : await auth.HASH_FALSO;
    const senhaOk = await auth.verificarSenha(senha, hashParaComparar);

    // Mesma resposta para: e-mail inexistente, senha errada, conta desativada
    // ou bloqueada — quem ataca não descobre quais e-mails existem.
    if (!usuario || !usuario.ativo || auth.estaBloqueado(usuario) || !senhaOk) {
      if (usuario && usuario.ativo && !auth.estaBloqueado(usuario)) {
        await auth.registrarFalha(usuario.id);
      }
      console.warn(`[auth] login recusado: ${JSON.stringify(email)} ip=${req.ip}`);
      return res.status(401).json({ erro: MENSAGEM_LOGIN_INVALIDO });
    }

    await auth.zerarFalhas(usuario.id);
    await auth.limparSessoesExpiradas();
    const token = await auth.criarSessao(usuario.id, req);
    auth.definirCookieSessao(req, res, token);
    console.log(`[auth] login ok: ${JSON.stringify(usuario.email)} ip=${req.ip}`);
    res.set("Cache-Control", "no-store");
    res.json({ ok: true, nome: usuario.nome });
  })
);

app.post(
  "/auth/logout",
  asyncH(async (req, res) => {
    await auth.encerrarSessaoDoRequest(req);
    auth.limparCookieSessao(req, res);
    res.json({ ok: true });
  })
);

app.get(
  "/auth/me",
  asyncH(async (req, res) => {
    res.set("Cache-Control", "no-store");
    const usuario = await auth.usuarioDaSessao(req);
    if (!usuario) return res.status(401).json({ erro: "Não autenticado." });
    res.json({ nome: usuario.nome, email: usuario.email, papel: usuario.papel });
  })
);

// ------------------------------------------------------------ convites ----
// A pessoa convidada abre o link e define a própria senha. O token vem depois do
// "#" na URL (o navegador não o envia ao servidor no GET, então ele não cai em
// logs nem em "Referer"); a página o lê e o manda no corpo de um POST.

app.get("/convite", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.sendFile(path.join(PUBLICO, "convite.html"));
});

const limiteConvite = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  skipSuccessfulRequests: true, // só tentativas que falham contam
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { erro: "Muitas tentativas. Aguarde alguns minutos e tente de novo." },
});

const MENSAGEM_CONVITE_INVALIDO =
  "Este convite é inválido, já foi usado ou expirou. Peça um novo a quem te convidou.";

app.post(
  "/auth/convite/info",
  limiteConvite,
  asyncH(async (req, res) => {
    res.set("Cache-Control", "no-store");
    const convite = await auth.consultarConvite(req.body?.token);
    if (!convite) return res.status(404).json({ erro: MENSAGEM_CONVITE_INVALIDO });
    res.json({ nome: convite.nome, email: convite.email });
  })
);

app.post(
  "/auth/convite/aceitar",
  limiteConvite,
  asyncH(async (req, res) => {
    res.set("Cache-Control", "no-store");
    const senha = typeof req.body?.senha === "string" ? req.body.senha : "";
    const resultado = await auth.aceitarConvite(req.body?.token, senha);
    if (resultado.erro) {
      if (resultado.codigo === "senha") return res.status(400).json({ erro: resultado.erro });
      return res.status(404).json({ erro: MENSAGEM_CONVITE_INVALIDO });
    }
    console.log(`[auth] convite aceito: ${JSON.stringify(resultado.email)} ip=${req.ip}`);
    res.json({ ok: true });
  })
);

app.get("/cadastro", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.sendFile(path.join(PUBLICO, "cadastro.html"));
});

const limiteCadastro = rateLimit({
  windowMs: 60 * 60 * 1000, // 5 solicitações por hora por IP
  limit: 5,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { erro: "Muitas solicitações. Tente novamente mais tarde." },
});

app.post(
  "/auth/cadastro",
  limiteCadastro,
  asyncH(async (req, res) => {
    const r = await auth.solicitarCadastro({
      email: req.body?.email,
      nome: req.body?.nome,
      senha: typeof req.body?.senha === "string" ? req.body.senha : "",
    });
    if (r.erro) return res.status(400).json({ erro: r.erro });
    console.log(`[auth] cadastro solicitado: ${JSON.stringify(auth.normalizarEmail(req.body?.email))} ip=${req.ip}`);
    res.json({ ok: true });
  })
);

// ================================================================
//  A PARTIR DAQUI, TUDO EXIGE LOGIN
// ================================================================
app.use(auth.exigirLogin);

app.use(express.static(PRIVADO)); // index.html, app.js, exames-data.js

// ------------------------------------------------ emissão do PDF ----

const limiteEmissao = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  keyGenerator: (req) => req.usuario.id,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { erro: "Muitas emissões em pouco tempo. Aguarde um instante." },
});

// Valida e limpa os dados no servidor — nunca confiamos no que veio do navegador.
function validarEmissao(corpo) {
  if (!corpo || typeof corpo !== "object") {
    return { erro: "corpo da requisição precisa ser um JSON válido" };
  }
  const cliente = typeof corpo.cliente === "string" ? corpo.cliente.trim() : "";
  if (!cliente || cliente.length > 120) {
    return { erro: "'cliente' é obrigatório (até 120 caracteres)" };
  }
  const data = typeof corpo.data === "string" ? corpo.data.trim() : "";
  if (!/^\d{2}\/\d{2}\/\d{4}$/.test(data)) {
    return { erro: "'data' precisa estar no formato dd/mm/aaaa" };
  }
  if (!Array.isArray(corpo.exames) || corpo.exames.length === 0 || corpo.exames.length > 40) {
    return { erro: "'exames' precisa ser uma lista de 1 a 40 itens" };
  }
  const exames = [];
  for (const item of corpo.exames) {
    const nome = item && typeof item.nome === "string" ? item.nome.trim() : "";
    if (!nome || nome.length > 200) {
      return { erro: "cada exame precisa ter um 'nome' (até 200 caracteres)" };
    }
    exames.push({ nome });
  }
  const v = corpo.valorTotal;
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v >= 1e7) {
    return { erro: "'valorTotal' precisa ser um número maior que zero" };
  }
  return { ok: { cliente, data, exames, valorTotal: Math.round(v * 100) / 100 } };
}

app.post(
  "/liberacao",
  limiteEmissao,
  asyncH(async (req, res) => {
    const { erro, ok: dados } = validarEmissao(req.body);
    if (erro) return res.status(400).json({ erro });

    const html = template({
      cliente: dados.cliente,
      data: dados.data,
      exames: dados.exames,
      totalFormatado: formatarMoeda(dados.valorTotal),
      logoUrl: LOGO_DATA_URI,
    });

    let page;
    try {
      const browser = await getBrowser();
      page = await browser.newPage();
      await page.setContent(html, { waitUntil: "load", timeout: 60000 });
      const pdf = await page.pdf({
        format: "A4",
        printBackground: true,
        margin: { top: "0", bottom: "0", left: "0", right: "0" },
      });
      // Sem dados do cliente no log (são dados de saúde); só quem emitiu e quantos exames.
      console.log(`[pdf] emitido por ${JSON.stringify(req.usuario.email)} (${dados.exames.length} exame(s))`);
      res.set({
        "Content-Type": "application/pdf",
        "Content-Disposition": "inline; filename=liberacao_coleta.pdf",
      });
      res.send(Buffer.from(pdf));
    } finally {
      if (page) await page.close().catch(() => {});
    }
  })
);

// ---------------------------------------------------------------- erros ----

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err.type === "entity.parse.failed") {
    return res.status(400).json({ erro: "JSON inválido." });
  }
  if (err.type === "entity.too.large") {
    return res.status(413).json({ erro: "Requisição grande demais." });
  }
  console.error("[erro]", err);
  res.status(500).json({ erro: "Erro interno. Tente novamente." });
});

// ---------------------------------------------------------------- start ----

const PORTA = process.env.PORT || 5000;

async function iniciar() {
  await db.iniciarBanco();
  await auth.garantirAdminInicial();
  await auth.limparSessoesExpiradas();
  setInterval(() => auth.limparSessoesExpiradas().catch(() => {}), 60 * 60 * 1000).unref();

  app.listen(PORTA, () => console.log(`API rodando em http://localhost:${PORTA}`));
}

iniciar().catch((err) => {
  console.error("Falha ao iniciar:", err);
  process.exit(1);
});

async function encerrar() {
  try {
    if (browserPromise) await (await browserPromise).close();
    await db.pool.end();
  } finally {
    process.exit(0);
  }
}
process.on("SIGINT", encerrar);
process.on("SIGTERM", encerrar); // o Render envia SIGTERM a cada novo deploy
