import React, { useMemo } from "react";

type Pt = { time: string; equity: number };
type Props = { data?: Pt[]; height?: number };

export default function EquitySparkline({ data = [], height = 80 }: Props) {
  const { path, min, max, last, ticks } = useMemo(() => {
    if (!Array.isArray(data) || data.length === 0) {
      return { path: "", min: 0, max: 0, last: 0, ticks: [] as number[] };
    }
    const values = data.map((d) => d.equity);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const pad = 6;
    const w = Math.max(120, data.length * 4); // largura adaptativa
    const h = height;
    const range = max - min || 1;

    const scaleX = (i: number) => {
      if (data.length === 1) return pad;
      return pad + (i / (data.length - 1)) * (w - pad * 2);
    };
    const scaleY = (v: number) => pad + (h - pad * 2) * (1 - (v - min) / range);

    const cmds: string[] = [];
    data.forEach((d, i) => {
      const x = scaleX(i);
      const y = scaleY(d.equity);
      cmds.push(i === 0 ? `M ${x} ${y}` : `L ${x} ${y}`);
    });

    // ticks (3 linhas de referência)
    const ticks = [min, (min + max) / 2, max];

    return {
      path: cmds.join(" "),
      min,
      max,
      last: values[values.length - 1],
      ticks,
    };
  }, [data, height]);

  const w = Math.max(120, (data?.length || 1) * 4);
  const h = height;
  const fmt = (v: number) => Number(v.toFixed(2));

  if (!path) {
    return (
      <div className="text-muted" style={{ fontSize: 12 }}>
        Sem dados
      </div>
    );
  }

  return (
    <div className="sparkline">
      <svg
        viewBox={`0 0 ${w} ${h}`}
        width="100%"
        height={h}
        preserveAspectRatio="none"
      >
        {/* linhas de referência */}
        <g opacity="0.2">
          {ticks.map((v, i) => {
            const y = 6 + (h - 12) * (1 - (v - min) / (max - min || 1));
            return (
              <line
                key={i}
                x1="0"
                y1={y}
                x2={w}
                y2={y}
                stroke="currentColor"
                strokeWidth="1"
              />
            );
          })}
        </g>

        {/* caminho da equity */}
        <path d={path} fill="none" stroke="currentColor" strokeWidth="2" />

        {/* ponto final */}
        <circle cx={w - 6} cy="10" r="0" fill="currentColor" />
      </svg>
      <div className="sparkline-legend">
        <span>
          Min: <strong>{fmt(min)}</strong>
        </span>
        <span>
          Max: <strong>{fmt(max)}</strong>
        </span>
        <span>
          Último: <strong>{fmt(last)}</strong>
        </span>
      </div>
    </div>
  );
}
