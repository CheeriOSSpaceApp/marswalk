import { defineConfig } from 'vite';
import { resolve } from 'path';

// base './' so the build works on GitHub Pages (project subpath) and Vercel
export default defineConfig({
  base: './',
  worker: { format: 'es' },   // planner.worker.js is a module worker
  build: {
    target: 'esnext',   // needed for top-level await
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'index.html'),
        console: resolve(__dirname, 'console.html'),
        tablet: resolve(__dirname, 'tablet.html'),
        plannerTest: resolve(__dirname, 'planner-test.html'),
      },
    },
  },
});
