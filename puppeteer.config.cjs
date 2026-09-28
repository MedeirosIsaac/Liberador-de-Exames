const { join } = require("path");

/**
 * Por padrão, o Puppeteer baixa o Chromium em $HOME/.cache/puppeteer.
 * Em algumas plataformas (como o Render), o diretório usado durante o
 * build não é o mesmo usado quando o serviço roda de fato, e o Chromium
 * "some" — o app quebra com "Could not find Chromium".
 *
 * Apontando o cache para uma pasta dentro do próprio projeto, o binário
 * fica garantido no mesmo lugar em toda etapa do deploy.
 *
 * @type {import("puppeteer").Configuration}
 */
module.exports = {
  cacheDirectory: join(__dirname, ".cache", "puppeteer"),
};
