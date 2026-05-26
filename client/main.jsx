/**
 * main.jsx — React entry point for dev-gui frontend.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './src/App.jsx';

const root = document.getElementById('root');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
);
