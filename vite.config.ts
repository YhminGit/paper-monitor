import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const isPublic = mode === 'public';
  return {
    plugins: [react()],
    base: isPublic ? '/paper-monitor/' : '/',
    publicDir: isPublic ? 'public-site' : false,
    // The public build consumes only a pre-sanitized static export, never local APIs.
    define: { 'import.meta.env.VITE_PUBLIC_LIBRARY': JSON.stringify(isPublic ? 'true' : 'false') },
    build: { outDir: isPublic ? 'dist-public' : 'dist', emptyOutDir: true },
    server: { host: '127.0.0.1', port: 5173, proxy: isPublic ? undefined : { '/api': 'http://127.0.0.1:3000' } },
  };
});
