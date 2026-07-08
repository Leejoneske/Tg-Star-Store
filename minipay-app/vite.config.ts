import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// This mini-app is served as a static SPA bundle from the main Express app,
// at /miniapp/. Building writes straight into ../public/miniapp so no manual
// copy step is needed — `npm run build` here is the only step required
// before deploying.
export default defineConfig({
  plugins: [react()],
  base: '/miniapp/',
  build: {
    outDir: '../public/miniapp',
    emptyOutDir: true,
  },
})
