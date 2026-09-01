import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    // Matches the browser support claimed in the README. Safari 14.1 rather
    // than 14.0 because 14.0 shipped a destructuring bug that build tools
    // refuse to work around.
    target: ['safari14.1', 'chrome90', 'firefox90', 'edge90'],
  },
});
