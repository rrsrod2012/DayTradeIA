import axios from "axios";

// Base da API:
// - Se VITE_API_BASE estiver definido, usa esse valor (ex.: http://localhost:4000)
// - Caso contrário, usa http://localhost:4000 por padrão
// OBS: adicionamos "/api" ao final para bater direto nas rotas do backend.
const ROOT =
  (import.meta as any)?.env?.VITE_API_BASE || "http://localhost:4000";

export const api = axios.create({
  baseURL: `${ROOT}/api`,
  headers: {
    Accept: "application/json",
    "Content-Type": "application/json",
  },
});
