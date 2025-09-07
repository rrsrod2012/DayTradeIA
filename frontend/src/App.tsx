import React from "react";
import AIControlsBar from "./components/AIControlsBar";
import AIProjectedPanel from "./components/AIProjectedPanel";
import AIConfirmedPanel from "./components/AIConfirmedPanel";
import AIPnLPanel from "./components/AIPnLPanel";
import AIChartWithMarkers from "./components/AIChartWithMarkers";
import ImportProgress from "./components/ImportProgress";

export default function App() {
  return (
    <>
      {/* Progresso de importação de CSV */}
      <ImportProgress />

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
