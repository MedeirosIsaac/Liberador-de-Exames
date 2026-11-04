(function () {
  'use strict';

  // O token vem depois do "#" (ex.: /convite#abc123): fica só no navegador.
  const token = decodeURIComponent(window.location.hash.slice(1));

  const $ = (id) => document.getElementById(id);

  function mostrar(idVisivel) {
    ['carregando', 'invalido', 'formulario', 'pronto'].forEach((id) => {
      $(id).classList.toggle('oculto', id !== idVisivel);
    });
  }

  async function postar(url, corpo) {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(corpo),
    });
    const dados = await resp.json().catch(() => ({}));
    return { ok: resp.ok, status: resp.status, dados };
  }

  async function iniciar() {
    if (!token) {
      $('msg-invalido').textContent = 'O link está incompleto. Abra o link inteiro que você recebeu.';
      return mostrar('invalido');
    }
    try {
      const r = await postar('/auth/convite/info', { token });
      if (!r.ok) {
        $('msg-invalido').textContent = r.dados.erro || 'Não foi possível verificar o convite.';
        return mostrar('invalido');
      }
      $('nome').textContent = r.dados.nome;
      $('email').textContent = r.dados.email;
      mostrar('formulario');
      $('senha').focus();
    } catch (_) {
      $('msg-invalido').textContent = 'Sem conexão com o servidor. Tente novamente em instantes.';
      mostrar('invalido');
    }
  }

  $('form-convite').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const status = $('status');
    const btn = $('btn-salvar');
    status.textContent = '';

    const senha = $('senha').value;
    if (senha !== $('confirmar').value) {
      status.textContent = 'As senhas não conferem.';
      return;
    }

    btn.disabled = true;
    btn.textContent = 'Salvando...';
    try {
      const r = await postar('/auth/convite/aceitar', { token, senha });
      if (!r.ok) {
        // convite que ficou inválido no meio do caminho (usado/expirado)
        if (r.status === 404) {
          $('msg-invalido').textContent = r.dados.erro;
          return mostrar('invalido');
        }
        throw new Error(r.dados.erro || 'Erro ' + r.status);
      }
      history.replaceState(null, '', window.location.pathname); // tira o token da barra de endereço
      mostrar('pronto');
    } catch (err) {
      status.textContent = err.message;
      btn.disabled = false;
      btn.textContent = 'Salvar senha';
    }
  });

  iniciar();
})();
