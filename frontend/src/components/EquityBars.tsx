import React, { useMemo } from "react";
import { Card } from "react-bootstrap";

type Trade = {
  exitTime: string;
  pnlPoints: number;
};

type Props = {
  trades?: Trade[];
  bucket?: "day" | "week";
  height?: number;
};

function fmt(n: number) {
  return Number(n.toFixed(2));
}

export default function EquityBars({
  trades = [],
  bucket = "day",
  height = 120,
}: Props) {
  const data = useMemo(() => {
    const map = new Map<string, number>();
    for (const t of trades) {
      const d = new Date(t.exitTime);
      const key =
        bucket === "week"
          ? `${d.getFullYear()}-W${String(getWeek(d)).padStart(2, "0")}`
          : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(
              2,
              "0"
            )}-${String(d.getDate()).padStart(2, "0")}`;
      map.set(key, (map.get(key) ?? 0) + (t.pnlPoints || 0));
    }
    const arr = Array.from(map.entries()).map(([label, value]) => ({
      label,
      value,
    }));
    arr.sort((a, b) => (a.label < b.label ? -1 : 1));
    return arr;
  }, [trades, bucket]);

  if (data.length === 0) {
    return (
      <div className="text-muted" style={{ fontSize: 12 }}>
        Sem trades para agrupar.
      </div>
    );
  }

  const maxAbs = Math.max(...data.map((d) => Math.abs(d.value)), 1);
  const barW = Math.max(10, Math.floor(600 / data.length) - 4);
  const chartW = Math.max(200, data.length * (barW + 4));
  const chartH = height;
  const midY = chartH / 2;

  return (
    <Card className="shadow-sm">
      <Card.Body>
        <div className="text-muted" style={{ fontSize: 12, marginBottom: 4 }}>
          PnL por {bucket === "week" ? "semana" : "dia"} (pts)
        </div>
        <div style={{ overflowX: "auto" }}>
          <svg
            viewBox={`0 0 ${chartW} ${chartH}`}
            width="100%"
            height={chartH}
            preserveAspectRatio="none"
          >
            {/* eixo zero */}
            <line
              x1="0"
              y1={midY}
              x2={chartW}
              y2={midY}
              stroke="currentColor"
              strokeWidth="1"
              opacity="0.2"
            />
            {data.map((d, i) => {
              const x = i * (barW + 4) + 2;
              const h = Math.max(
                1,
                (Math.abs(d.value) / maxAbs) * (chartH / 2 - 8)
              );
              const y = d.value >= 0 ? midY - h : midY;
              return (
                <g key={i}>
                  <rect
                    x={x}
                    y={y}
                    width={barW}
                    height={h}
                    fill={d.value >= 0 ? "currentColor" : "currentColor"}
                    opacity={d.value >= 0 ? 0.9 : 0.5}
                  />
                  <title>{`${d.label}: ${fmt(d.value)} pts`}</title>
                </g>
              );
            })}
          </svg>
        </div>
        <div className="d-flex flex-wrap gap-2 mt-2" style={{ fontSize: 12 }}>
          <span className="text-muted">Total:</span>
          <strong>{fmt(data.reduce((s, d) => s + d.value, 0))} pts</strong>
        </div>
      </Card.Body>
    </Card>
  );
}

// ISO week (aproximação simples)
function getWeek(d: Date) {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}
