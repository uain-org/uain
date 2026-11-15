import tailwindcss from '@tailwindcss/postcss';
import vinext from 'vinext';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'UAIN_DEV_API');
  const apiTarget =
    process.env.UAIN_DEV_API || env.UAIN_DEV_API || 'https://uain.global';

  return {
    css: { postcss: { plugins: [tailwindcss()] } },
    plugins: [vinext()],
    server: {
      proxy: {
        // Keep the browser on the local origin; the production API owns its DB.
        '/api': { target: apiTarget, changeOrigin: true },
      },
    },
  };
});
