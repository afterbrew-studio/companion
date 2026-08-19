import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles.css';

// Desk is intentionally a paper-like focused surface. It does not inherit the
// full control plane's dense dark chrome, even when both apps are open together.
document.documentElement.classList.remove('dark');
document.documentElement.style.colorScheme = 'light';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
