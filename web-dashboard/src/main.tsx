import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><App /></React.StrictMode>
);

/* Phase 5 (D): register the fleet-state IndexedDB service worker. Dev hosts serve
   over http://localhost, where SWs are allowed; anything non-secure just skips it. */
if ('serviceWorker' in navigator && (location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname))) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => { /* dev server without SW headers — dashboard still works online-first */ });
  });
}
