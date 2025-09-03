import React from "react";
import AIControlsBar from "./components/AIControlsBar";
import AIProjectedPanel from "./components/AIProjectedPanel";
import AIConfirmedPanel from "./components/AIConfirmedPanel";
import AIPnLPanel from "./components/AIPnLPanel";
import AIChartWithMarkers from "./components/AIChartWithMarkers";

export default function App() {
  return (
    <>
      {/* Barra fixa com calendário, seletor de tipo e PnL */}
      <AIControlsBar collapsedByDefault />

      {/* Gráfico com marcadores dos dois tipos */}
      <AIChartWithMarkers />

      {/* Tabelas */}
      <AIProjectedPanel />
      <AIConfirmedPanel />

      {/* Resumo de PnL (backtest) */}
      <AIPnLPanel />
    </>
  );
}
