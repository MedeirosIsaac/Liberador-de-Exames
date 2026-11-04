/**
 * Administração de usuários (rode na pasta do projeto, com o .env preenchido):
 *
 *   npm run usuarios -- convidar email@exemplo.com "Nome Completo" [admin|operador]
 *        (gera um link para a PRÓPRIA pessoa definir a senha — é o jeito recomendado;
 *         para quem já tem cadastro, serve para redefinir a senha)
 *   npm run usuarios -- criar    email@exemplo.com "Nome Completo" [admin|operador]
 *        (você mesmo define a senha dela)
 *   npm run usuarios -- senha    email@exemplo.com
 *   npm run usuarios -- desativar email@exemplo.com
 *   npm run usuarios -- ativar    email@exemplo.com
 *   npm run usuarios -- listar
 *
 * A senha é pedida no terminal (não aparece na tela e não fica no histórico).
 * Para administrar o banco de produção, use no .env a mesma DATABASE_URL do Render.
 */
require("dotenv").config({ quiet: true });
const readline = require("readline");
const db = require("../db");
const auth = require("../auth");

// Quando a entrada não é um terminal (ex.: testes automáticos), lê as linhas do stdin.
let linhasStdin = null;
async function proximaLinhaStdin() {
  if (!linhasStdin) {
    linhasStdin = await new Promise((resolve) => {
      const linhas = [];
      const rl = readline.createInterface({ input: process.stdin });
      rl.on("line", (l) => linhas.push(l));
      rl.on("close", () => resolve(linhas));
    });
  }
  return linhasStdin.shift() ?? "";
}

function lerSenhaOculta(pergunta) {
  if (!process.stdin.isTTY) return proximaLinhaStdin();

  return new Promise((resolve) => {
    process.stdout.write(pergunta);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    let senha = "";

    const terminar = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("data", aoReceber);
      process.stdout.write("\n");
    };
    const aoReceber = (texto) => {
      for (const c of texto) {
        if (c === "\r" || c === "\n" || c === "\u0004") {
          terminar();
          return resolve(senha);
        }
        if (c === "\u0003") {
          terminar();
          process.exit(130);
        }
        if (c === "\u007f" || c === "\b") senha = senha.slice(0, -1);
        else senha += c;
      }
    };
    process.stdin.on("data", aoReceber);
  });
}

async function pedirSenhaNova() {
  const senha = await lerSenhaOculta("Senha (mín. 10 caracteres): ");
  const erro = auth.validarSenhaNova(senha);
  if (erro) throw new Error(erro);
  const confirmacao = await lerSenhaOculta("Repita a senha: ");
  if (senha !== confirmacao) throw new Error("As senhas não conferem.");
  return senha;
}

async function exigirUsuario(email) {
  const usuario = await auth.buscarUsuarioPorEmail(email);
  if (!usuario) throw new Error(`Usuário não encontrado: ${email}`);
  return usuario;
}

const comandos = {
  async convidar(email, nome, papel = "operador") {
    if (!email || !nome) throw new Error('Uso: convidar <email> "<nome>" [admin|operador]');
    const existente = await auth.buscarUsuarioPorEmail(email);
    const { token, expira, horas } = await auth.criarConvite({ email, nome, papel });
    const base = (process.env.APP_URL || "https://SEU-SITE.onrender.com").replace(/\/+$/, "");

    console.log(`\nConvite criado para ${auth.normalizarEmail(email)} (uso único, válido por ${horas} horas).`);
    if (existente) {
      console.log("Atenção: já existe cadastro com esse e-mail. O link servirá para a pessoa REDEFINIR a senha.");
    }
    console.log("\nEnvie este link somente para ela (por mensagem direta, nunca em grupo):\n");
    console.log(`  ${base}/convite#${token}\n`);
    console.log(`Expira em: ${expira.toLocaleString("pt-BR")}`);
    console.log("O link só aparece agora; se perder, gere outro (o anterior deixa de valer).");
    if (!process.env.APP_URL) {
      console.log("Dica: defina APP_URL no .env com o endereço do site para o link já sair completo.");
    }
  },

  async criar(email, nome, papel = "operador") {
    if (!email || !nome) throw new Error('Uso: criar <email> "<nome>" [admin|operador]');
    const senha = await pedirSenhaNova();
    await auth.criarUsuario({ email, nome, senha, papel });
    console.log(`Usuário criado: ${auth.normalizarEmail(email)} (${papel})`);
  },

  async senha(email) {
    if (!email) throw new Error("Uso: senha <email>");
    const usuario = await exigirUsuario(email);
    const novaSenha = await pedirSenhaNova();
    const senhaHash = await auth.hashSenha(novaSenha);
    await db.query(
      `UPDATE usuarios SET senha_hash = $2, tentativas_falhas = 0, bloqueado_ate = NULL WHERE id = $1`,
      [usuario.id, senhaHash]
    );
    await auth.encerrarSessoesDoUsuario(usuario.id); // derruba quem estiver logado com a senha antiga
    console.log(`Senha alterada e sessões encerradas: ${usuario.email}`);
  },

  async desativar(email) {
    if (!email) throw new Error("Uso: desativar <email>");
    const usuario = await exigirUsuario(email);
    await db.query(`UPDATE usuarios SET ativo = FALSE WHERE id = $1`, [usuario.id]);
    await auth.encerrarSessoesDoUsuario(usuario.id);
    console.log(`Usuário desativado e sessões encerradas: ${usuario.email}`);
  },

  async ativar(email) {
    if (!email) throw new Error("Uso: ativar <email>");
    const usuario = await exigirUsuario(email);
    await db.query(
      `UPDATE usuarios SET ativo = TRUE, tentativas_falhas = 0, bloqueado_ate = NULL WHERE id = $1`,
      [usuario.id]
    );
    console.log(`Usuário ativado: ${usuario.email}`);
  },

  async listar() {
    const { rows } = await db.query(
      `SELECT email, nome, papel, ativo, criado_em FROM usuarios ORDER BY criado_em`
    );
    if (rows.length === 0) console.log("Nenhum usuário cadastrado.");
    for (const u of rows) {
      console.log(`${u.ativo ? "ativo   " : "INATIVO "} ${u.papel.padEnd(8)} ${u.email}  —  ${u.nome}`);
    }
    const { rows: convites } = await db.query(
      `SELECT email, expira_em FROM convites WHERE encerrado_em IS NULL AND expira_em > now() ORDER BY expira_em`
    );
    if (convites.length) {
      console.log("\nConvites pendentes:");
      for (const c of convites) {
        console.log(`  ${c.email}  (expira em ${new Date(c.expira_em).toLocaleString("pt-BR")})`);
      }
    }
  },
};

(async () => {
  const [comando, ...args] = process.argv.slice(2);
  try {
    if (!comandos[comando]) {
      console.log("Comandos: convidar | criar | senha | desativar | ativar | listar  (veja o topo deste arquivo)");
      process.exitCode = 1;
    } else {
      await db.iniciarBanco();
      await comandos[comando](...args);
    }
  } catch (err) {
    console.error("Erro:", err.message);
    process.exitCode = 1;
  } finally {
    await db.pool.end();
  }
})();
