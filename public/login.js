(function () {
  'use strict';

  const form = document.getElementById('form-login');
  const status = document.getElementById('status');
  const btn = document.getElementById('btn-entrar');

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    status.textContent = '';
    btn.disabled = true;
    btn.textContent = 'Entrando...';

    try {
      const resp = await fetch('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          email: document.getElementById('email').value,
          senha: document.getElementById('senha').value,
        }),
      });
      const dados = await resp.json().catch(() => ({}));

      if (!resp.ok) throw new Error(dados.erro || 'Erro ' + resp.status);

      window.location.replace('/');
    } catch (err) {
      status.textContent = err.message;
      document.getElementById('senha').value = '';
      btn.disabled = false;
      btn.textContent = 'Entrar';
    }
  });
})();
