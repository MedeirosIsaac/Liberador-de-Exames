(function () {
  'use strict';

  const LIMITE_SUGESTOES = 20;
  const listaExames = document.getElementById('lista-exames');

  // ------------------------------------------------------------ sessão ----

  function irParaLogin() {
    window.location.replace('/login');
  }

  async function carregarUsuario() {
    try {
      const resp = await fetch('/auth/me', { credentials: 'same-origin' });
      if (resp.status === 401) return irParaLogin();
      const usuario = await resp.json();
      document.getElementById('usuario-nome').textContent = usuario.nome;
    } catch (_) {
      /* sem rede: o usuário continua vendo o formulário */
    }
  }

  document.getElementById('btn-sair').addEventListener('click', async () => {
    try {
      await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' });
    } finally {
      irParaLogin();
    }
  });

  carregarUsuario();

  // ------------------------------------------------------ busca de exames ----

  function normalizar(texto) {
    return texto
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .trim();
  }

  function buscarExames(consulta) {
    const termo = normalizar(consulta);
    if (!termo) return EXAMES_DISPONIVEIS.slice(0, LIMITE_SUGESTOES);
    return EXAMES_DISPONIVEIS
      .filter((ex) => normalizar(ex.nome).includes(termo))
      .slice(0, LIMITE_SUGESTOES);
  }

  function criarLinhaExame(nome = '') {
    const row = document.createElement('div');
    row.className = 'exame-row';
    row.innerHTML = `
      <div class="autocomplete-wrap">
        <input type="text" class="exame-nome" placeholder="Digite para buscar..." autocomplete="off">
        <div class="autocomplete-list"></div>
      </div>
      <button type="button" class="remover-exame" title="Remover">×</button>
    `;
    row.querySelector('.exame-nome').value = nome;
    row.querySelector('.remover-exame').addEventListener('click', () => row.remove());
    listaExames.appendChild(row);
    ativarAutocomplete(row);
  }

  function ativarAutocomplete(row) {
    const inputNome = row.querySelector('.exame-nome');
    const dropdown = row.querySelector('.autocomplete-list');

    function renderizar(itens) {
      dropdown.replaceChildren();

      if (itens.length === 0) {
        const vazio = document.createElement('div');
        vazio.className = 'autocomplete-vazio';
        vazio.textContent = 'Nenhum exame encontrado';
        dropdown.appendChild(vazio);
      } else {
        itens.forEach((ex) => {
          const item = document.createElement('div');
          item.className = 'autocomplete-item';
          item.textContent = ex.nome;
          // mousedown (e não click) dispara antes do blur do campo
          item.addEventListener('mousedown', (ev) => {
            ev.preventDefault();
            inputNome.value = ex.nome;
            dropdown.classList.remove('aberta');
          });
          dropdown.appendChild(item);
        });
      }
      dropdown.classList.add('aberta');
    }

    inputNome.addEventListener('focus', () => renderizar(buscarExames(inputNome.value)));
    inputNome.addEventListener('input', () => renderizar(buscarExames(inputNome.value)));
    inputNome.addEventListener('blur', () => {
      setTimeout(() => dropdown.classList.remove('aberta'), 120);
    });
  }

  document.getElementById('btn-add-exame').addEventListener('click', () => criarLinhaExame());
  criarLinhaExame(); // começa com uma linha em branco

  // ------------------------------------------------------------- envio ----

  const form = document.getElementById('form-liberacao');
  const status = document.getElementById('status');
  const btnGerar = document.getElementById('btn-gerar');

  function mostrar(texto, tipo) {
    status.textContent = texto;
    status.className = 'status' + (tipo ? ' ' + tipo : '');
  }

  function formatarDataBR(isoDate) {
    const [ano, mes, dia] = isoDate.split('-');
    return `${dia}/${mes}/${ano}`;
  }

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    mostrar('');

    const exames = Array.from(document.querySelectorAll('.exame-row'))
      .map((row) => ({ nome: row.querySelector('.exame-nome').value.trim() }))
      .filter((e) => e.nome);

    if (exames.length === 0) return mostrar('Adicione ao menos um exame.', 'erro');

    const valorTotal = parseFloat(document.getElementById('valor_total').value.replace(',', '.'));
    if (!valorTotal || valorTotal <= 0) return mostrar('Informe o valor total.', 'erro');

    const payload = {
      cliente: document.getElementById('cliente').value.trim(),
      data: formatarDataBR(document.getElementById('data').value),
      exames,
      valorTotal,
    };

    btnGerar.disabled = true;
    btnGerar.textContent = 'Gerando...';

    try {
      const resp = await fetch('/liberacao', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(payload),
      });

      if (resp.status === 401) return irParaLogin(); // sessão expirou

      if (!resp.ok) {
        const erro = await resp.json().catch(() => ({}));
        throw new Error(erro.erro || `Erro ${resp.status}`);
      }

      const blob = await resp.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `liberacao_${payload.cliente.replace(/\s+/g, '_')}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);

      mostrar('PDF gerado com sucesso.', 'ok');
    } catch (err) {
      mostrar(err.message, 'erro');
    } finally {
      btnGerar.disabled = false;
      btnGerar.textContent = 'Gerar e baixar PDF';
    }
  });
})();
