(function () {
  'use strict';

  const form = document.getElementById('form-cadastro');
  const status = document.getElementById('status');
  const btn = document.getElementById('btn-enviar');

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    status.textContent = '';

    const senha = document.getElementById('senha').value;
    const confirmar = document.getElementById('confirmar').value;
    if (senha !== confirmar) {
      status.textContent = 'As senhas não conferem. Digite a mesma senha nos dois campos.';
      return;
    }

    btn.disabled = true;
    btn.textContent = 'Enviando...';

    try {
      const resp = await fetch('/auth/cadastro', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          nome: document.getElementById('nome').value,
          email: document.getElementById('email').value,
          senha: senha,
        }),
      });
      const dados = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(dados.erro || 'Erro ' + resp.status);

      document.getElementById('formulario').classList.add('oculto');
      document.getElementById('pronto').classList.remove('oculto');
    } catch (err) {
      status.textContent = err.message;
      btn.disabled = false;
      btn.textContent = 'Enviar solicitação';
    }
  });
})();
