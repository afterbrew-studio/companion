// Copy-to-clipboard for the install commands. A separate file, not inline, so
// the CSP in nginx.conf can stay on `script-src 'self'`.
document.querySelectorAll('.cmd').forEach((button) => {
  const state = button.querySelector('.copy-state');
  let timer;
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(button.dataset.copy);
      state.textContent = 'Copied';
      button.classList.add('copied');
    } catch {
      // Clipboard is blocked (insecure origin, or the user said no). Say so
      // rather than claiming a copy that did not happen.
      state.textContent = 'Select it';
    }
    clearTimeout(timer);
    timer = setTimeout(() => {
      state.textContent = 'Copy';
      button.classList.remove('copied');
    }, 2000);
  });
});
