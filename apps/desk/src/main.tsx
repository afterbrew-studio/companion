import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { initTheme } from '@companion/module-core/client';
import { App } from './App.js';
import './styles.css';

initTheme();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
