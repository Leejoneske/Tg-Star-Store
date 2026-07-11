import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// This MiniPay app is served as a static SPA bundle from the main Express app,
// at /minipay/. Building writes straight into ../public/minipay so no manual
// copy step is needed — `npm run build` here is the only step required
// before deploying.
export default defineConfig({
  plugins: [react()],
  base: '/minipay/',
  server: {
    allowedHosts: true,
  },
  build: {
    outDir: '../public/minipay',
    emptyOutDir: true,
  },
})
