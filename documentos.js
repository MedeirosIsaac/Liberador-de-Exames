/**
 * Autenticidade dos documentos emitidos
 * -------------------------------------
 * Cada PDF gerado ganha um código único, guardado no banco junto com os dados
 * que foram impressos e o nome de quem emitiu. Quem recebe o documento lê o
 * QR Code (ou digita o código) em /verificar e vê os dados ORIGINAIS: se o PDF
 * tiver sido editado, ou se o código não existir, a fraude aparece na hora.
 */
const crypto = require("crypto");
const QRCode = require("qrcode");
const db = require("./db");

// Sem 0/O e 1/I/L, para ninguém errar ao digitar o código.
const ALFABETO = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const TAMANHO = 12; // 31^12 ≈ 7,8 × 10^17 combinações: impossível adivinhar um código válido
const FUSO = "America/Fortaleza"; // mesmo horário de Natal/RN (o servidor do Render roda em UTC)

function formatarCodigo(limpo) {
  return `${limpo.slice(0, 4)}-${limpo.slice(4, 8)}-${limpo.slice(8)}`;
}

function gerarCodigo() {
  let c = "";
  for (let i = 0; i < TAMANHO; i++) c += ALFABETO[crypto.randomInt(ALFABETO.length)];
  return formatarCodigo(c);
}

// Aceita o código com ou sem traços, com espaços e em minúsculas.
function normalizarCodigo(texto) {
  const limpo = String(texto || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (limpo.length !== TAMANHO) return null;
  for (const ch of limpo) if (!ALFABETO.includes(ch)) return null;
  return formatarCodigo(limpo);
}

// Grava o documento ANTES de gerar o PDF, porque o código precisa estar impresso nele.
async function registrarDocumento({ usuario, cliente, data, exames, valorTotal }) {
  for (let tentativa = 0; tentativa < 3; tentativa++) {
    const codigo = gerarCodigo();
    try {
      const { rows } = await db.query(
        `INSERT INTO documentos
           (codigo, emissor_id, emissor_nome, emissor_email, cliente, data_coleta, exames, valor_total)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING codigo, emitido_em`,
        [codigo, usuario.id, usuario.nome, usuario.email, cliente, data, JSON.stringify(exames), valorTotal]
      );
      return rows[0];
    } catch (err) {
      if (err.code !== "23505") throw err; // 23505 = código repetido (raríssimo): sorteia outro
    }
  }
  throw new Error("Não foi possível gerar o código de autenticidade.");
}

// Usado se o PDF falhar depois do registro: não deixa no banco um documento que nunca existiu.
async function removerDocumento(codigo) {
  await db.query(`DELETE FROM documentos WHERE codigo = $1`, [codigo]);
}

async function buscarDocumento(codigo) {
  const { rows } = await db.query(
    `SELECT codigo, emissor_nome, cliente, data_coleta, exames, valor_total, emitido_em, cancelado_em
       FROM documentos WHERE codigo = $1`,
    [codigo]
  );
  return rows[0] || null;
}

// "Maria Souza Oliveira" -> "Maria S. O." (a página de verificação é pública)
function mascararNome(nome) {
  const partes = String(nome || "").trim().split(/\s+/).filter(Boolean);
  if (partes.length <= 1) return partes[0] || "";
  return [partes[0], ...partes.slice(1).map((p) => p[0].toUpperCase() + ".")].join(" ");
}

function formatarDataHora(valor) {
  const d = new Date(valor);
  const data = d.toLocaleDateString("pt-BR", { timeZone: FUSO });
  const hora = d.toLocaleTimeString("pt-BR", { timeZone: FUSO, hour: "2-digit", minute: "2-digit" });
  return { data, hora, completo: `${data} às ${hora}` };
}

function gerarQrDataUri(url) {
  return QRCode.toDataURL(url, { errorCorrectionLevel: "M", margin: 1, width: 240 });
}

module.exports = {
  normalizarCodigo,
  registrarDocumento,
  removerDocumento,
  buscarDocumento,
  mascararNome,
  formatarDataHora,
  gerarQrDataUri,
};
