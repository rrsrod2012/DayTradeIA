import React, { useMemo } from "react";
import { Card } from "react-bootstrap";

type Trade = {
  entryTime?: string;
  pnlPoints?: number;
  pnl?: number;
};

type Props = {
  trades: Trade[];
  darkMode?: boolean;
  title?: string;
};

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

/** Heatmap simples 24x1 com win rate por hora de entrada (0..23) */
export default function WinrateHeatmap({
  trades,
  darkMode = false,
  title = "Win Rate por Hora (entrada)",
}: Props) {
  const buckets = useMemo(() => {
    const acc: Array<{ wins: number; total: number }> = Array.from(
      { length: 24 },
      () => ({ wins: 0, total: 0 })
    );
    for (const t of trades || []) {
      if (!t.entryTime) continue;
      const d = new Date(t.entryTime);
      const hr = d.getHours();
      const pts =
        typeof t.pnlPoints === "number"
          ? t.pnlPoints
          : typeof t.pnl === "number"
          ? t.pnl
          : 0;
      acc[hr].total += 1;
      if (pts > 0) acc[hr].wins += 1;
    }
    return acc.map((b, h) => ({
      hour: h,
      wins: b.wins,
      total: b.total,
      wr: b.total ? b.wins / b.total : 0,
    }));
  }, [trades]);

  // escala de cor (vermelho → amarelo → verde)
  const colorForWR = (wr: number) => {
    // 0 = vermelho (rgb 239,68,68), 0.5 = amarelo (rgb 234,179,8), 1 = verde (rgb 34,197,94)
    let r: number, g: number, b: number;
    if (wr < 0.5) {
      const t = wr / 0.5; // 0..1
      r = Math.round(lerp(239, 234, t));
      g = Math.round(lerp(68, 179, t));
      b = Math.round(lerp(68, 8, t));
    } else {
      const t = (wr - 0.5) / 0.5; // 0..1
      r = Math.round(lerp(234, 34, t));
      g = Math.round(lerp(179, 197, t));
      b = Math.round(lerp(8, 94, t));
    }
    const alpha = 0.9;
    return `rgba(${r},${g},${b},${alpha})`;
  };

  const textColor = darkMode ? "#e5e7eb" : "#212529";
  const subTextColor = darkMode ? "#9ca3af" : "#6c757d";
  const borderColor = darkMode ? "#374151" : "#e5e7eb";
  const cellBorder = darkMode ? "#111827" : "#ffffff";

  return (
    <Card className="shadow-sm">
      <Card.Header className="fw-semibold">{title}</Card.Header>
      <Card.Body>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(24, 1fr)",
            gap: 2,
          }}
        >
          {buckets.map((b) => (
            <div
              key={b.hour}
              title={`${String(b.hour).padStart(2, "0")}h — WR: ${(
                b.wr * 100
              ).toFixed(1)}%  (${b.wins}/${b.total})`}
              style={{
                height: 36,
                background: b.total
                  ? colorForWR(b.wr)
                  : darkMode
                  ? "#1f2937"
                  : "#f1f3f5",
                border: `1px solid ${cellBorder}`,
                borderRadius: 6,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 11,
                color: textColor,
              }}
            >
              <div style={{ textAlign: "center", lineHeight: 1.1 }}>
                <div style={{ fontWeight: 600 }}>
                  {(b.wr * 100).toFixed(0)}%
                </div>
                <div style={{ color: subTextColor }}>
                  {String(b.hour).padStart(2, "0")}h
                </div>
              </div>
            </div>
          ))}
        </div>
        <div
          style={{
            marginTop: 8,
            fontSize: 12,
            color: subTextColor,
            borderTop: `1px dashed ${borderColor}`,
            paddingTop: 8,
          }}
        >
          Dica: concentre operações nos horários com win rate mais alto; teste
          filtrar os buckets fracos.
        </div>
      </Card.Body>
    </Card>
  );
}
