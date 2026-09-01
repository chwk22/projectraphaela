/**
 * main.jsx — browser entry point.
 *
 * The component takes no props and manages its own storage, so mounting it is
 * the whole of the integration.
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import RaphaelaProject from './RaphaelaProject.jsx';

const container = document.getElementById('root');
if (!container) {
  throw new Error('No #root element found. Check index.html.');
}

createRoot(container).render(
  <React.StrictMode>
    <RaphaelaProject />
  </React.StrictMode>
);
