import React, { useMemo, useRef, useState, useCallback } from "react";
import { Card, Button } from "react-bootstrap";
import { toCSV, downloadCSV } from "../utils/csv";

type Trade = {
  exitTime?: string; // ISO
  entryTime?: string; // backup
  pnlPoints?: number;
  pnl?: number;
};

type Props = {
  trades: Trade[];
  height?: number; // px
  title?: string;
  darkMode?: boolean;
};

/** Curva de equity acumulada com tooltip, download (SVG/PNG) e CSV; marcadores por resultado do trade */
export default function EquityCurve({
  trades,
  height = 200,
  title = "Curva de Equity (pts acumulados)",
  darkMode = false,
}: Props) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const { points, minY, maxY, labels, deltas } = useMemo(() => {
    const sorted = [...(trades || [])].sort((a, b) => {
      const ta = (a.exitTime || a.entryTime || "").toString();
      const tb = (b.exitTime || b.entryTime || "").toString();
      return ta.localeCompare(tb);
    });
    let cum = 0;
    const pts: { x: number; y: number }[] = [];
    const labels: { idx: number; time: string; equity: number }[] = [];
    const deltas: number[] = [];
    for (let i = 0; i < sorted.length; i++) {
      const t = sorted[i];
      const v =
        typeof t.pnlPoints === "number"
          ? t.pnlPoints
          : typeof t.pnl === "number"
          ? t.pnl
          : 0;
      cum += v;
      deltas.push(v);
      pts.push({ x: i, y: cum });
      labels.push({
        idx: i,
        time: (t.exitTime || t.entryTime || "").toString(),
        equity: cum,
      });
    }
    const ys = pts.map((p) => p.y);
    const minY = ys.length ? Math.min(...ys) : 0;
    const maxY = ys.length ? Math.max(...ys) : 0;
    return { points: pts, minY, maxY, labels, deltas };
  }, [trades]);

  const padding = 28;
  const h = height;
  const width = Math.max(points.length * 10, 360); // 10px por trade
  const w = width;

  const yMin = Math.min(0, minY);
  const yMax = Math.max(0, maxY, yMin + 1e-6);
  const ySpan = yMax - yMin || 1;
  const xMax = Math.max(points.length - 1, 1);

  const toX = (i: number) => {
    const frac = i / xMax;
    return padding + frac * (w - 2 * padding);
  };
  const toY = (y: number) => {
    const frac = (y - yMin) / ySpan; // 0..1
    return h - padding - frac * (h - 2 * padding);
  };

  const pathD = points.length
    ? points
        .map(
          (p, idx) =>
            `${idx === 0 ? "M" : "L"} ${toX(p.x).toFixed(1)} ${toY(p.y).toFixed(
              1
            )}`
        )
        .join(" ")
    : "";

  // Paleta por tema
  const colorAxis = darkMode ? "#777" : "#999";
  const colorZero = darkMode ? "#666" : "#bbb";
  const colorPath = darkMode ? "#6ea8fe" : "#0d6efd";
  const colorText = darkMode ? "#e9ecef" : "#212529";
  const colorTextMuted = darkMode ? "#adb5bd" : "#6c757d";
  const colorTooltipBg = darkMode ? "#1f2937" : "#ffffff";
  const colorTooltipBorder = darkMode ? "#374151" : "#ced4da";
  const colorHoverPointBorder = darkMode ? "#111827" : "#ffffff";

  // Linha de zero
  const zeroY = toY(0);
  const showZero = zeroY > padding && zeroY < h - padding;

  // Hover logic
  const nearestIndexFromMouse = useCallback(
    (evt: React.MouseEvent<SVGSVGElement>) => {
      if (!svgRef.current || points.length === 0) return null;
      const rect = svgRef.current.getBoundingClientRect();
      const clientX = evt.clientX - rect.left;
      const frac = (clientX - padding) / Math.max(1, w - 2 * padding);
      const idx = Math.round(frac * xMax);
      return Math.min(Math.max(idx, 0), points.length - 1);
    },
    [points, w, padding, xMax]
  );

  const onMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const idx = nearestIndexFromMouse(e);
    if (idx === null || Number.isNaN(idx)) return;
    setHoverIdx(idx);
  };
  const onMouseLeave = () => setHoverIdx(null);

  // Download helpers
  const downloadSVG = () => {
    if (!svgRef.current) return;
    const serializer = new XMLSerializer();
    const src = serializer.serializeToString(svgRef.current);
    const blob = new Blob([src], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "equity_curve.svg";
    a.click();
    URL.revokeObjectURL(url);
  };

  const downloadPNG = async () => {
    if (!svgRef.current) return;
    const serializer = new XMLSerializer();
    const src = serializer.serializeToString(svgRef.current);
    const img = new Image();
    const svgBlob = new Blob([src], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(svgBlob);
    await new Promise<void>((resolve) => {
      img.onload = () => resolve();
      img.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      // Fundo conforme tema
      ctx.fillStyle = darkMode ? "#0b1220" : "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);
      const link = document.createElement("a");
      link.href = canvas.toDataURL("image/png");
      link.download = "equity_curve.png";
      link.click();
    }
    URL.revokeObjectURL(url);
  };

  // CSV Equity
  const downloadEquityCSV = () => {
    const rows = labels.map((l) => ({
      index: l.idx,
      time: l.time,
      equity_points: l.equity,
      trade_pnl_points: deltas[l.idx] ?? 0,
    }));
    const csv = toCSV(rows, [
      "index",
      "time",
      "equity_points",
      "trade_pnl_points",
    ]);
    downloadCSV("equity_by_trade.csv", csv);
  };

  // Dados do ponto em hover
  const hover = hoverIdx !== null && points[hoverIdx] ? points[hoverIdx] : null;
  const hoverX = hover ? toX(hover.x) : 0;
  const hoverY = hover ? toY(hover.y) : 0;
  const hoverLabel = hoverIdx !== null ? labels[hoverIdx] : null;

  return (
    <Card className="shadow-sm">
      <Card.Header className="d-flex align-items-center justify-content-between">
        <div className="fw-semibold">{title}</div>
        <div className="d-flex gap-2">
          <Button
            size="sm"
            variant="outline-secondary"
            onClick={downloadEquityCSV}
          >
            CSV Equity
          </Button>
          <Button size="sm" variant="outline-secondary" onClick={downloadSVG}>
            Baixar SVG
          </Button>
          <Button size="sm" variant="outline-secondary" onClick={downloadPNG}>
            Baixar PNG
          </Button>
        </div>
      </Card.Header>

      <Card.Body style={{ overflowX: "auto" }}>
        <svg
          ref={svgRef}
          width={w}
          height={h}
          role="img"
          aria-label="Equity curve"
          onMouseMove={onMouseMove}
          onMouseLeave={onMouseLeave}
          style={{
            cursor: points.length ? "crosshair" : "default",
            background: "transparent",
          }}
        >
          {/* Eixos simples */}
          <line
            x1={padding}
            y1={h - padding}
            x2={w - padding}
            y2={h - padding}
            stroke={colorAxis}
            strokeWidth={0.5}
          />
          <line
            x1={padding}
            y1={padding}
            x2={padding}
            y2={h - padding}
            stroke={colorAxis}
            strokeWidth={0.5}
          />

          {/* Zero */}
          {showZero && (
            <line
              x1={padding}
              y1={zeroY}
              x2={w - padding}
              y2={zeroY}
              stroke={colorZero}
              strokeDasharray="4 4"
              strokeWidth={0.75}
            />
          )}

          {/* Path principal */}
          {pathD ? (
            <path d={pathD} fill="none" stroke={colorPath} strokeWidth={1.5} />
          ) : (
            <text x={padding} y={h / 2} fill={colorTextMuted} fontSize="12">
              Sem trades para plotar
            </text>
          )}

          {/* Marcadores por trade (verde ganho, vermelho perda, cinza empate) */}
          {points.length > 0 &&
            points.map((p, i) => {
              const v = deltas[i] ?? 0;
              const fill =
                v > 0
                  ? darkMode
                    ? "#22c55e"
                    : "#198754"
                  : v < 0
                  ? darkMode
                    ? "#ef4444"
                    : "#dc3545"
                  : darkMode
                  ? "#9ca3af"
                  : "#6c757d";
              return (
                <circle
                  key={i}
                  cx={toX(p.x)}
                  cy={toY(p.y)}
                  r={2.5}
                  fill={fill}
                />
              );
            })}

          {/* Hover guide/tooltip */}
          {hover && (
            <>
              {/* Linha vertical */}
              <line
                x1={hoverX}
                y1={padding}
                x2={hoverX}
                y2={h - padding}
                stroke={colorAxis}
                strokeDasharray="3 3"
                strokeWidth={0.75}
              />
              {/* Ponto destacado */}
              <circle
                cx={hoverX}
                cy={hoverY}
                r={3.8}
                fill={colorPath}
                stroke={colorHoverPointBorder}
                strokeWidth={1.2}
              />
              {/* Tooltip */}
              <g>
                <rect
                  x={Math.min(hoverX + 10, w - 200)}
                  y={Math.max(hoverY - 48, padding)}
                  width={190}
                  height={54}
                  rx={6}
                  ry={6}
                  fill={colorTooltipBg}
                  stroke={colorTooltipBorder}
                />
                <text
                  x={Math.min(hoverX + 16, w - 194)}
                  y={Math.max(hoverY - 30, padding + 14)}
                  fill={colorText}
                  fontSize="12"
                >
                  {`Trade #${hoverIdx}`}
                </text>
                <text
                  x={Math.min(hoverX + 16, w - 194)}
                  y={Math.max(hoverY - 14, padding + 30)}
                  fill={colorTextMuted}
                  fontSize="11"
                >
                  {hoverLabel?.time
                    ? new Date(hoverLabel.time).toLocaleString()
                    : "—"}
                </text>
                <text
                  x={Math.min(hoverX + 16, w - 194)}
                  y={Math.max(hoverY + 2, padding + 46)}
                  fill={
                    (deltas[hoverIdx ?? 0] ?? 0) >= 0
                      ? darkMode
                        ? "#22c55e"
                        : "#198754"
                      : darkMode
                      ? "#ef4444"
                      : "#dc3545"
                  }
                  fontSize="12"
                >
                  {`Equity: ${hover?.y?.toFixed(2)} pts — Δ: ${(
                    deltas[hoverIdx ?? 0] ?? 0
                  ).toFixed(2)} pts`}
                </text>
              </g>
            </>
          )}
        </svg>
      </Card.Body>
    </Card>
  );
}
