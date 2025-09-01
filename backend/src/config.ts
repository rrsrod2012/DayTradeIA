/* Config centralizada para tunar custos, cooldown e logging sem mexer no código. */
export const Config = {
  PORT: Number(process.env.PORT || 4000),

  // Custos por trade (pontos)
  COST_PER_TRADE_POINTS: Number(process.env.COST_PER_TRADE_POINTS || 2),
  SLIPPAGE_POINTS: Number(process.env.SLIPPAGE_POINTS || 1),

  // MTF
  REQUIRE_MTF_CONFIRM: (process.env.REQUIRE_MTF_CONFIRM || "0") === "1",
  MTF_CONFIRM_TF: process.env.MTF_CONFIRM_TF || "M15",

  // Cooldown inteligente
  COOLDOWN_SMART: (process.env.COOLDOWN_SMART || "1") === "1",
  COOLDOWN_FAIL_N: Number(process.env.COOLDOWN_FAIL_N || 2),
  COOLDOWN_BLOCK_CANDLES: Number(process.env.COOLDOWN_BLOCK_CANDLES || 8),

  // Watcher
  WATCHER_DEBOUNCE_MS: Number(process.env.WATCHER_DEBOUNCE_MS || 500),

  // Logging
  LOG_JSON: (process.env.LOG_JSON || "1") === "1",
  LOG_LEVEL: process.env.LOG_LEVEL || "info",
};
export default Config;
