(function () {
  'use strict';

  const form = document.getElementById('form-senha');
  const status = document.getElementById('status');
  const btn = document.getElementById('btn-salvar');

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    status.textContent = '';

    const senhaAtual = document.getElementById('atual').value;
    const senhaNova = document.getElementById('nova').value;
    if (senhaNova !== document.getElementById('confirmar').value) {
      status.textContent = 'As novas senhas não conferem. Digite a mesma senha nos dois campos.';
      return;
    }

    btn.disabled = true;
    btn.textContent = 'Salvando...';

    try {
      const resp = await fetch('/auth/trocar-senha', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ senhaAtual, senhaNova }),
      });
      if (resp.status === 401) {
        window.location.replace('/login');
        return;
      }
      const dados = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(dados.erro || 'Erro ' + resp.status);

      document.getElementById('formulario').classList.add('oculto');
      document.getElementById('pronto').classList.remove('oculto');
    } catch (err) {
      status.textContent = err.message;
      btn.disabled = false;
      btn.textContent = 'Salvar nova senha';
    }
  });
})();
