import { defineConfig } from "vite";

// Config async: tenta carregar @vitejs/plugin-react se estiver instalado.
// Caso não esteja, segue sem o plugin (usando esbuild com JSX automático).
export default defineConfig(async () => {
  let reactPlugin: any = null;
  try {
    // @ts-ignore - carregamento dinâmico opcional
    reactPlugin = (await import("@vitejs/plugin-react")).default;
  } catch {
    // plugin não instalado — seguimos sem ele
    console.warn(
      "[vite] @vitejs/plugin-react não encontrado; usando fallback sem o plugin."
    );
  }

  return {
    plugins: reactPlugin ? [reactPlugin()] : [],
    server: {
      port: 5173,
      proxy: {
        "/api": {
          target: process.env.VITE_API_TARGET || "http://localhost:4000",
          changeOrigin: true,
          secure: false,
        },
      },
    },
    // Fallback para transformar JSX/TSX mesmo sem o plugin do React
    esbuild: {
      jsx: "automatic",
      jsxImportSource: "react",
    },
  };
});
