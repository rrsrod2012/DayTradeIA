import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // Encaminha chamadas de API para o backend em dev
      "/api": {
        target: "http://localhost:4000",
        changeOrigin: true,
        // mantém o prefixo /api do lado do backend
        rewrite: (path) => path,
      },
    },
  },
});
