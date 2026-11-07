(function () {
  'use strict';

  const listaInativos = document.getElementById('lista-inativos');
  const listaAtivos = document.getElementById('lista-ativos');
  const status = document.getElementById('status');

  async function api(url, opcoes) {
    const resp = await fetch(url, Object.assign({
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
    }, opcoes || {}));
    const dados = await resp.json().catch(() => ({}));
    if (resp.status === 401) {
      window.location.replace('/login');
      throw new Error('Sessão expirada. Entre novamente.');
    }
    if (!resp.ok) throw new Error(dados.erro || 'Erro ' + resp.status);
    return dados;
  }

  function el(tag, classe, texto) {
    const e = document.createElement(tag);
    if (classe) e.className = classe;
    if (texto !== undefined) e.textContent = texto; // textContent: nome digitado por terceiros nunca vira HTML
    return e;
  }

  function botao(texto, classe, pergunta, acao) {
    const b = el('button', classe, texto);
    b.type = 'button';
    b.addEventListener('click', async () => {
      if (pergunta && !window.confirm(pergunta)) return;
      b.disabled = true;
      status.textContent = '';
      try {
        await acao();
        await carregar();
      } catch (err) {
        status.textContent = err.message;
        b.disabled = false;
      }
    });
    return b;
  }

  function post(id, acao, corpo) {
    return api('/admin/api/usuarios/' + encodeURIComponent(id) + '/' + acao, {
      method: 'POST',
      body: JSON.stringify(corpo || {}),
    });
  }

  function linha(u, euId) {
    const item = el('li', 'usuario');

    const info = el('div', 'info');
    info.appendChild(el('strong', '', u.nome));
    info.appendChild(el('span', 'email', u.email));

    const meta = el('span', 'meta');
    meta.appendChild(el('span', u.ativo ? 'selo' : 'selo pendente', u.ativo ? 'Ativo' : 'Inativo'));
    if (u.papel === 'admin') meta.appendChild(el('span', 'selo admin', 'Administrador'));
    meta.appendChild(document.createTextNode('Cadastrado em ' + new Date(u.criado_em).toLocaleDateString('pt-BR')));
    info.appendChild(meta);
    item.appendChild(info);

    const acoes = el('div', 'acoes');
    if (u.id === euId) {
      acoes.appendChild(el('span', 'voce', 'Esta é a sua conta'));
    } else if (!u.ativo) {
      acoes.appendChild(botao('Aprovar acesso', 'principal', null, () => post(u.id, 'ativar')));
      acoes.appendChild(botao('Excluir', 'perigo',
        'Excluir o cadastro de ' + u.email + '? Isso não pode ser desfeito.',
        () => post(u.id, 'excluir')));
    } else {
      if (u.papel === 'admin') {
        acoes.appendChild(botao('Tornar operador', '',
          u.email + ' deixará de ser administrador. Confirmar?',
          () => post(u.id, 'papel', { papel: 'operador' })));
      } else {
        acoes.appendChild(botao('Tornar administrador', '',
          u.email + ' poderá aprovar e remover usuários. Confirmar?',
          () => post(u.id, 'papel', { papel: 'admin' })));
      }
      acoes.appendChild(botao('Desativar', 'perigo',
        'Desativar ' + u.email + '? A pessoa será desconectada na hora.',
        () => post(u.id, 'desativar')));
    }
    item.appendChild(acoes);
    return item;
  }

  function preencher(lista, usuarios, euId, textoVazio) {
    lista.replaceChildren();
    if (usuarios.length === 0) {
      lista.appendChild(el('li', 'vazio', textoVazio));
      return;
    }
    for (const u of usuarios) lista.appendChild(linha(u, euId));
  }

  async function carregar() {
    const dados = await api('/admin/api/usuarios');
    preencher(listaInativos, dados.usuarios.filter((u) => !u.ativo), dados.eu, 'Nenhuma solicitação pendente.');
    preencher(listaAtivos, dados.usuarios.filter((u) => u.ativo), dados.eu, 'Nenhum usuário ativo.');
  }

  carregar().catch((err) => { status.textContent = err.message; });
})();
