// ===============================
// FILE: frontend/vite.config.ts
// ===============================
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // Redireciona requisições de API para o backend
      '/api': {
        target: 'http://localhost:3002',
        changeOrigin: true,
      },
      // Redireciona requisições de Admin para o backend
      '/admin': {
        target: 'http://localhost:3002',
        changeOrigin: true,
      },
      // Redireciona as novas rotas de risco e broker
      '/broker': {
        target: 'http://localhost:3002',
        changeOrigin: true,
      },
      '/risk': {
        target: 'http://localhost:3002',
        changeOrigin: true,
      },
      // Redireciona a conexão WebSocket para o backend
      '/stream': {
        target: 'ws://localhost:3002',
        ws: true,
      },
    },
  },
})