import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const previewHost = env.CONSOLE_PREVIEW_HOST;
  const previewOrigins = new Set([
    ...[18102, 18103].flatMap(port => [`http://127.0.0.1:${port}`, `http://localhost:${port}`]),
    ...(previewHost ? [`https://${previewHost}`] : []),
  ]);
  return {
    plugins: [react(), tailwindcss(), {
      name: 'console-preview-origin',
      configurePreviewServer(server) {
        server.middlewares.use((request, response, next) => {
          const origin = request.headers.origin;
          if (request.url?.startsWith('/api/') && origin && !previewOrigins.has(origin)) {
            response.writeHead(403, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            response.end(JSON.stringify({ error: { code: 'FORBIDDEN', message: '预览入口不允许此来源', retryable: false, correlation_id: 'preview-origin' } }));
            return;
          }
          next();
        });
      },
    }],
    server: {
      proxy: {
        '/api': {
          target: env.CONTROL_API_PROXY_TARGET || 'http://127.0.0.1:18100',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api/, ''),
        },
      },
    },
    preview: {
      allowedHosts: previewHost ? [previewHost] : [],
      headers: { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer' },
      proxy: {
        '^/api/v1/': {
          target: env.CONTROL_API_PROXY_TARGET || 'http://127.0.0.1:18100',
          changeOrigin: true,
          rewrite: path => path.replace(/^\/api/, ''),
          // The preview gateway validates the browser origin above. Backend calls
          // retain the user's Bearer token and use a server-to-server hop.
          configure(proxy) { proxy.on('proxyReq', request => request.removeHeader('origin')); },
        },
      },
    },
    build: { sourcemap: false, chunkSizeWarningLimit: 750 },
  };
});
