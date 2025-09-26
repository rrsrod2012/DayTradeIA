import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Ajusta o proxy para usar IPv4 explicitamente (evita ::1 no Windows)
// e garante headers corretos para CORS no desenvolvimento.
export default defineConfig({
  plugins: [react()],
  server: {
    host: true, // permite acesso via LAN se precisar
    port: 5173, // ajuste se usar outra porta no seu setup
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3000", // BACKEND em IPv4
        changeOrigin: true,
        secure: false,
        ws: false,
        // se a sua API no backend já vem com /api prefixado, não reescreva
        // rewrite: (path) => path.replace(/^\/api/, "/api"),
      },
      // se você estiver chamando o microserviço IA direto do FE (geralmente não precisa)
      "/ml": {
        target: "http://127.0.0.1:3000",
        changeOrigin: true,
        secure: false,
        ws: false,
      },
      // ✅ NOVO: proxy para as rotas /admin do backend
      "/admin": {
        target: "http://127.0.0.1:3000",
        changeOrigin: true,
        secure: false,
        ws: false,
      },
    },
  },
});
