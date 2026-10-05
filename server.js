/**
 * API de geração da "Liberação para coleta"
 * --------------------------------------------
 * Recebe os dados via POST (JSON) e devolve o PDF pronto, gerado a partir
 * do template_original.hbs (HTML/CSS + Handlebars), renderizado por um
 * Chromium headless (Puppeteer).
 *
 * Instalar dependências:
 *   npm install express handlebars puppeteer
 *
 * Rodar:
 *   node server.js
 *   (sobe em http://localhost:5000)
 *
 * Exemplo de chamada:
 *   curl -X POST http://localhost:5000/liberacao \
 *     -H "Content-Type: application/json" \
 *     -d '{
 *           "cliente": "Ana Débora Morais da Rosa",
 *           "data": "20/08/2026",
 *           "exames": [
 *             {"nome": "Selênio Sérico"},
 *             {"nome": "Hormônio Anti-Mulleriano"}
 *           ],
 *           "valorTotal": 147.00
 *         }' \
 *     --output liberacao.pdf
 */

const express = require("express");
const fs = require("fs");
const path = require("path");
const handlebars = require("handlebars");
const puppeteer = require("puppeteer");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const TEMPLATE_PATH = path.join(__dirname, "template_original.hbs");
const templateFonte = fs.readFileSync(TEMPLATE_PATH, "utf8");
const template = handlebars.compile(templateFonte);

// A logo mora de verdade em public/logo.png (é só substituir o arquivo pra
// trocar). O Chromium headless do Puppeteer não consegue carregar file://
// diretamente por segurança, então lemos o arquivo aqui e entregamos pro
// template já como data URI — o PDF funciona sem depender de rede nem de
// caminho de arquivo em tempo de renderização.
const LOGO_PATH = path.join(__dirname, "public", "logo.png");
const logoBase64 = fs.readFileSync(LOGO_PATH).toString("base64");
const LOGO_DATA_URI = `data:image/png;base64,${logoBase64}`;

const CAMPOS_OBRIGATORIOS = ["cliente", "data", "exames", "valorTotal"];

function formatarMoeda(valor) {
  return valor.toFixed(2).replace(".", ",");
}

// Uma instância de browser reaproveitada entre requisições (evita o custo
// de abrir um Chromium novo a cada chamada).
let browserPromise = null;
function getBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        // Evita falhas por pouca memória compartilhada em containers
        // como o Render free tier (512 MB de RAM).
        "--disable-dev-shm-usage",
      ],
      // Só necessário se o Chrome baixado pelo Puppeteer não estiver no
      // caminho padrão (ex: containers Docker com Chrome do sistema).
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    });
  }
  return browserPromise;
}

app.post("/liberacao", async (req, res) => {
  const dados = req.body;

  if (!dados || typeof dados !== "object") {
    return res.status(400).json({ erro: "corpo da requisição precisa ser um JSON válido" });
  }

  const faltando = CAMPOS_OBRIGATORIOS.filter((campo) => !(campo in dados));
  if (faltando.length > 0) {
    return res.status(400).json({ erro: `campos obrigatórios ausentes: ${faltando.join(", ")}` });
  }

  if (!Array.isArray(dados.exames) || dados.exames.length === 0) {
    return res.status(400).json({ erro: "'exames' precisa ser uma lista com ao menos 1 item" });
  }

  if (typeof dados.valorTotal !== "number" || dados.valorTotal <= 0) {
    return res.status(400).json({ erro: "'valorTotal' precisa ser um número maior que zero" });
  }

  try {
    const html = template({
      cliente: dados.cliente,
      data: dados.data,
      exames: dados.exames,
      totalFormatado: formatarMoeda(dados.valorTotal),
      logoUrl: LOGO_DATA_URI,
    });

    const browser = await getBrowser();
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load", timeout: 60000 });
    const pdfBuffer = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "0", bottom: "0", left: "0", right: "0" },
    });
    await page.close();

    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": "inline; filename=liberacao_coleta.pdf",
    });
    res.send(Buffer.from(pdfBuffer));
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: `falha ao gerar o PDF: ${err.message}` });
  }
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", endpoint: "/liberacao (POST)" });
});

const PORTA = process.env.PORT || 5000;
app.listen(PORTA, () => {
  console.log(`API rodando em http://localhost:${PORTA}`);
});

process.on("SIGINT", async () => {
  if (browserPromise) {
    const browser = await browserPromise;
    await browser.close();
  }
  process.exit(0);
});
