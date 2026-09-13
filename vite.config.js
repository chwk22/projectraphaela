import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],

  /**
   * Relative asset paths.
   *
   * A GitHub Pages *project* site is served from a subdirectory —
   * https://<user>.github.io/<repo>/ — not from the domain root. Vite's
   * default base of '/' emits absolute paths like /assets/index-abc.js, which
   * resolve to the wrong place there and 404.
   *
   * './' makes every emitted path relative to index.html, so the same build
   * works at the domain root, in a repo subdirectory, and from the local
   * filesystem, without the repo name being hardcoded anywhere.
   *
   * If you later add a client-side router, switch to an explicit
   * base: '/RaphaelaProject/' instead — relative paths break once the URL can
   * have a depth the bundler did not anticipate.
   */
  base: './',

  build: {
    // Matches the browser support claimed in the README. Safari 14.1 rather
    // than 14.0 because 14.0 shipped a destructuring bug that build tools
    // refuse to work around.
    target: ['safari14.1', 'chrome90', 'firefox90', 'edge90'],
  },
});
