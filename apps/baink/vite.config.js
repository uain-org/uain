import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import { kitFiles } from './deploy/kit-files.mjs';

// Serve the one-file agent kit at <base>uain-agent.mjs, byte for byte, so an
// agent fetches it with one command, together with its checksum and a copy at an
// address that names its version (deploy/kit-files.mjs). The source stays
// agent-kit/uain-agent.mjs.
const agentKit = () => ({
  name: 'baink-agent-kit',
  generateBundle() {
    for (const [fileName, source] of kitFiles(readFileSync(new URL('./agent-kit/uain-agent.mjs', import.meta.url))))
      this.emitFile({ type: 'asset', fileName, source });
  },
});

export default defineConfig({base:process.env.BAINK_BASE_PATH||'/',plugins:[agentKit()],server:{port:5178,proxy:{'/api':{target:`http://127.0.0.1:${process.env.BAINK_API_PORT||8798}`,changeOrigin:false}}},build:{target:'es2022',chunkSizeWarningLimit:700,rollupOptions:{output:{manualChunks:(id)=>id.includes('/three/')?'three':undefined}}}});
