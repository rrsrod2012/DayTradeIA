import React, {
  useEffect,
  useMemo,
  useRef,
  useState,
  useCallback,
} from "react";

type Candle = {
  time: string; // ISO
  date?: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
};

type Trade = {
  side?: "BUY" | "SELL";
  entryTime?: string; // ISO
  entryPrice?: number;
  exitTime?: string; // ISO
  exitPrice?: number;
  // Campos opcionais para identificar TP/SL
  takeProfitPrice?: number;
  stopLossPrice?: number;
  tpPrice?: number;
  slPrice?: number;
  take?: number;
  stop?: number;
  exitReason?: "TP" | "SL" | string;
  pnlPoints?: number;
  pnl?: number;
};

type Props = {
  candles: Candle[];
  ema9?: (number | null)[];
  ema21?: (number | null)[];
  showFibo?: boolean;
  darkMode?: boolean;

  /** Overlay de trades (já filtrados, se aplicável) */
  trades?: Trade[];

  /** Altura opcional do gráfico (px) */
  height?: number;

  /** Permite desativar a navegação se necessário */
  enableNavigation?: boolean;
};

/**
 * CandleChart interativo:
 * - Pan (drag do mouse) por padrão
 * - Zoom por seleção (segure SHIFT e arraste)
 * - Zoom pela roda do mouse (foco no cursor)
 * - Tooltip/crosshair por hover (tempo, OHLC, Δ, EMAs)
 * - Duplo clique para resetar zoom
 * - EMAs e overlay de trades (entry/exit + TP/SL)
 * - Mini-mapa com janela arrastável + botão "Ir para o fim"
 * - Popover clicável em cada trade com detalhes e "Ir para o trade"
 * - Popover ao clicar no candle (métricas da barra)
 * - Exportar SVG/PNG e atalhos de navegação (H/J/K/L, Ctrl+←/→)
 */
export default function CandleChart({
  candles,
  ema9 = [],
  ema21 = [],
  showFibo = false,
  darkMode = false,
  trades = [],
  height = 360,
  enableNavigation = true,
}: Props) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const miniRef = useRef<SVGSVGElement | null>(null);
  const [containerW, setContainerW] = useState<number>(640);

  // ======= Navegação (zoom/pan) =======
  const [pxPerBar, setPxPerBar] = useState<number>(6); // [2..36]
  const [offset, setOffset] = useState<number>(0);

  // Hover
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  // Seleção para zoom (drag retângulo com SHIFT)
  const [sel, setSel] = useState<{ active: boolean; x0: number; x1: number }>({
    active: false,
    x0: 0,
    x1: 0,
  });

  // Estado de pan
  const [isPanning, setIsPanning] = useState(false);

  // Mini-mapa (arrasto da janela)
  const miniDrag = useRef<{
    active: boolean;
    startX: number;
    startOffset: number;
  }>({ active: false, startX: 0, startOffset: 0 });

  // ======= Popovers =======
  const [selectedTrade, setSelectedTrade] = useState<{
    x: number;
    y: number;
    trade: Trade;
    iEntry: number;
    iExit: number;
  } | null>(null);

  const [selectedCandle, setSelectedCandle] = useState<{
    x: number;
    y: number;
    idx: number;
  } | null>(null);

  // Atualiza largura do container com ResizeObserver
  useEffect(() => {
    if (!wrapRef.current) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        const w = Math.floor(e.contentRect.width);
        if (w > 0) setContainerW(w);
      }
    });
    ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, []);

  // Dimensões
  const paddingLeft = 56;
  const paddingRight = 16;
  const paddingTop = 16;
  const paddingBottom = 28;
  const w = containerW;
  const h = height;

  const innerW = Math.max(1, w - paddingLeft - paddingRight);
  const barsFit = Math.max(1, Math.floor(innerW / Math.max(2, pxPerBar)));
  const maxStart = Math.max(0, candles.length - barsFit);
  const startIndex = Math.min(Math.max(0, Math.floor(offset)), maxStart);
  const endIndex = Math.min(candles.length - 1, startIndex + barsFit - 1);

  // Mini-mapa dimensões
  const miniH = 56;
  const miniPaddingTop = 6;
  const miniPaddingBottom = 12;
  const miniInnerH = miniH - miniPaddingTop - miniPaddingBottom;

  // Ao trocar a largura ou escalas, mantenha janela válida
  useEffect(() => {
    const fit = Math.max(1, Math.floor(innerW / Math.max(2, pxPerBar)));
    const maxS = Math.max(0, candles.length - fit);
    setOffset((prev) => Math.min(prev, maxS));
  }, [innerW, pxPerBar, candles.length]);

  // Escalas Y (com base na janela visível)
  const { minPrice, maxPrice, xForIndex, yForPrice } = useMemo(() => {
    const prices: number[] = [];
    for (let i = startIndex; i <= endIndex; i++) {
      const c = candles[i];
      prices.push(c.low, c.high);
    }
    // incluir EMAs se disponíveis (apenas faixa visível)
    for (let i = startIndex; i <= endIndex; i++) {
      const v9 = ema9[i];
      const v21 = ema21[i];
      if (typeof v9 === "number") prices.push(v9);
      if (typeof v21 === "number") prices.push(v21);
    }
    const minP = prices.length ? Math.min(...prices) : 0;
    const maxP = prices.length ? Math.max(...prices) : 1;
    const pad = (maxP - minP) * 0.05 || 1;
    const minPrice = minP - pad;
    const maxPrice = maxP + pad;
    const innerH = h - paddingTop - paddingBottom;

    const xForIndex = (i: number) => {
      const rel = (i - startIndex) / Math.max(1, barsFit - 1);
      return paddingLeft + rel * innerW;
    };
    const yForPrice = (p: number) =>
      paddingTop +
      (1 - (p - minPrice) / Math.max(1e-9, maxPrice - minPrice)) * innerH;

    return { minPrice, maxPrice, xForIndex, yForPrice };
  }, [candles, ema9, ema21, startIndex, endIndex, innerW, h, barsFit]);

  // Cores por tema
  const colorAxis = darkMode ? "#8b8b8b" : "#666";
  const colorGrid = darkMode ? "#2d2f33" : "#eee";
  const colorBull = darkMode ? "#22c55e" : "#198754";
  const colorBear = darkMode ? "#ef4444" : "#dc3545";
  const colorWick = darkMode ? "#cbd5e1" : "#333";
  const colorEma9 = darkMode ? "#f59e0b" : "#fd7e14";
  const colorEma21 = darkMode ? "#60a5fa" : "#0d6efd";
  const colorText = darkMode ? "#e5e7eb" : "#212529";
  const colorTP = darkMode ? "#16a34a" : "#198754";
  const colorSL = darkMode ? "#dc2626" : "#dc3545";
  const tooltipBg = darkMode ? "#0b1220" : "#ffffff";
  const tooltipBd = darkMode ? "#374151" : "#ced4da";
  const crosshair = darkMode ? "#6366f1" : "#6c757d";
  const miniLine = darkMode ? "#94a3b8" : "#6c757d";
  const miniWindow = darkMode
    ? "rgba(99,102,241,0.18)"
    : "rgba(13,110,253,0.18)";
  const miniWindowBorder = darkMode ? "#6366f1" : "#0d6efd";

  // Eixos e grid (apenas algumas linhas de preço)
  const yTicks = useMemo(() => {
    const n = 5;
    const ticks: number[] = [];
    for (let i = 0; i < n; i++) {
      const t = minPrice + ((maxPrice - minPrice) * i) / (n - 1);
      ticks.push(t);
    }
    return ticks;
  }, [minPrice, maxPrice]);

  // EMAs em paths (apenas faixa visível)
  const emaPath = (series: (number | null)[]) => {
    const pts: string[] = [];
    for (let i = startIndex; i <= endIndex; i++) {
      const v = series[i];
      if (typeof v === "number") {
        const x = xForIndex(i).toFixed(1);
        const y = yForPrice(v).toFixed(1);
        pts.push(`${pts.length ? "L" : "M"} ${x} ${y}`);
      }
    }
    return pts.join(" ");
  };

  // ======= Overlay de Trades (só se ambos entry/exit estiverem visíveis) =======
  const tradeMarkers = useMemo(() => {
    if (!candles.length || !trades?.length) return [];

    const indexNearest = (iso?: string) => {
      if (!iso) return null;
      const target = new Date(iso).getTime();
      let best: number | null = null;
      let bestDiff = Infinity;
      for (let i = 0; i < candles.length; i++) {
        const ts = new Date(candles[i].time).getTime();
        const d = Math.abs(ts - target);
        if (d < bestDiff) {
          bestDiff = d;
          best = i;
        }
      }
      return best;
    };

    return trades
      .map((t) => {
        const iEntry = indexNearest(t.entryTime);
        const iExit = indexNearest(t.exitTime);
        if (iEntry == null || iExit == null) return null;
        if (
          iEntry < startIndex ||
          iEntry > endIndex ||
          iExit < startIndex ||
          iExit > endIndex
        ) {
          return null;
        }

        const x1 = xForIndex(iEntry);
        const x2 = xForIndex(iExit);

        const y1 =
          typeof t.entryPrice === "number"
            ? yForPrice(t.entryPrice)
            : yForPrice(candles[iEntry].close);
        const y2 =
          typeof t.exitPrice === "number"
            ? yForPrice(t.exitPrice)
            : yForPrice(candles[iExit].close);

        const isWin =
          typeof t.entryPrice === "number" &&
          typeof t.exitPrice === "number" &&
          ((t.side === "BUY" && t.exitPrice > t.entryPrice) ||
            (t.side === "SELL" && t.exitPrice < t.entryPrice));

        const tp =
          t.takeProfitPrice ??
          t.tpPrice ??
          t.take ??
          (t.exitReason === "TP" ? t.exitPrice : undefined);
        const sl =
          t.stopLossPrice ??
          t.slPrice ??
          t.stop ??
          (t.exitReason === "SL" ? t.exitPrice : undefined);

        const yTP = typeof tp === "number" ? yForPrice(tp) : null;
        const ySL = typeof sl === "number" ? yForPrice(sl) : null;

        return {
          trade: t,
          iEntry,
          iExit,
          x1,
          y1,
          x2,
          y2,
          yTP,
          ySL,
          isWin,
          side: t.side,
        };
      })
      .filter(Boolean) as Array<{
      trade: Trade;
      iEntry: number;
      iExit: number;
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      yTP: number | null;
      ySL: number | null;
      isWin: boolean;
      side?: string;
    }>;
  }, [candles, trades, startIndex, endIndex, xForIndex, yForPrice]);

  // ======= Utilitários =======
  const clampOffset = useCallback(
    (value: number, nextPxPerBar: number = pxPerBar) => {
      const fit = Math.max(1, Math.floor(innerW / Math.max(2, nextPxPerBar)));
      const maxS = Math.max(0, candles.length - fit);
      return Math.min(Math.max(0, value), maxS);
    },
    [innerW, candles.length, pxPerBar]
  );

  const indexFromClientX = (clientX: number) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const x = clientX - rect.left;
    const rel = (x - paddingLeft) / innerW;
    const i = Math.round(startIndex + rel * (barsFit - 1));
    if (i < startIndex || i > endIndex) return null;
    return { i, xCanvas: x };
  };

  // ======= Interação: pan/zoom/seleção =======
  const dragRef = useRef<{
    dragging: boolean;
    startX: number;
    startOffset: number;
    selecting: boolean; // SHIFT pressionado
  }>({ dragging: false, startX: 0, startOffset: 0, selecting: false });

  const onMouseDown = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!enableNavigation) return;
    const isShift = e.shiftKey; // SHIFT ativa seleção para zoom
    dragRef.current = {
      dragging: true,
      startX: e.clientX,
      startOffset: offset,
      selecting: isShift,
    };
    if (isShift) {
      // inicia retângulo de seleção
      const rect = svgRef.current!.getBoundingClientRect();
      const x = Math.min(
        Math.max(e.clientX - rect.left, paddingLeft),
        w - paddingRight
      );
      setSel({ active: true, x0: x, x1: x });
    } else {
      setIsPanning(true);
    }
  };

  const onMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    // hover/crosshair
    const pos = indexFromClientX(e.clientX);
    setHoverIdx(pos?.i ?? null);

    if (!enableNavigation) return;
    if (!dragRef.current.dragging) return;

    if (!dragRef.current.selecting) {
      // PAN (padrão)
      const dx = e.clientX - dragRef.current.startX;
      const barsDelta = -dx / Math.max(2, pxPerBar);
      setOffset(clampOffset(dragRef.current.startOffset + barsDelta));
      return;
    }

    // Seleção de faixa (SHIFT)
    const rect = svgRef.current!.getBoundingClientRect();
    const x = Math.min(
      Math.max(e.clientX - rect.left, paddingLeft),
      w - paddingRight
    );
    setSel((s) => ({ ...s, x1: x }));
  };

  const onMouseUp = (_e: React.MouseEvent<SVGSVGElement>) => {
    if (!enableNavigation) return;
    if (!dragRef.current.dragging) return;

    if (dragRef.current.selecting) {
      // finalizar seleção
      const x0 = Math.max(Math.min(sel.x0, sel.x1), paddingLeft);
      const x1 = Math.min(Math.max(sel.x0, sel.x1), w - paddingRight);
      const span = Math.abs(x1 - x0);
      setSel({ active: false, x0: 0, x1: 0 });

      if (span >= 12) {
        const rel0 = (x0 - paddingLeft) / innerW;
        const rel1 = (x1 - paddingLeft) / innerW;
        const i0 = startIndex + rel0 * (barsFit - 1);
        const i1 = startIndex + rel1 * (barsFit - 1);
        const newBars = Math.max(2, Math.round(i1 - i0 + 1));
        const newPx = Math.min(36, Math.max(2, innerW / newBars));
        const newStart = i0;
        setPxPerBar(newPx);
        setOffset(clampOffset(newStart, newPx));
      }
    }

    dragRef.current.dragging = false;
    setIsPanning(false);
  };

  const onMouseLeave = () => {
    setHoverIdx(null);
    if (!enableNavigation) return;
    dragRef.current.dragging = false;
    setSel({ active: false, x0: 0, x1: 0 });
    setIsPanning(false);
  };

  // Clique no candle para abrir popover
  const onClickMain = (e: React.MouseEvent<SVGSVGElement>) => {
    // Evita que clique no gráfico feche popovers imediatamente (o handler global fecha)
    e.stopPropagation();
    // Se foi clique de seleção (Shift), ignorar
    if (dragRef.current.selecting) return;
    const pos = indexFromClientX(e.clientX);
    if (!pos) return;
    const idx = pos.i;
    const xCanvas = pos.xCanvas;
    const c = candles[idx];
    if (!c) return;
    setSelectedTrade(null); // fecha popover de trade se aberto
    setSelectedCandle({
      x: xCanvas,
      y: yForPrice(c.close),
      idx,
    });
  };

  // Zoom com roda do mouse (scroll)
  const onWheel = (e: React.WheelEvent<SVGSVGElement>) => {
    if (!enableNavigation) return;
    // evita scroll da página
    e.preventDefault();

    // deltaY < 0 => zoom in; deltaY > 0 => zoom out
    const step = Math.max(-1, Math.min(1, e.deltaY / 100)); // normaliza
    const zoomFactor = step < 0 ? 1.2 : 1 / 1.2;

    const newPx = Math.min(36, Math.max(2, pxPerBar * zoomFactor));

    const rect = svgRef.current?.getBoundingClientRect();
    const mouseX = rect ? e.clientX - rect.left : paddingLeft + innerW / 2;
    const rel = Math.min(1, Math.max(0, (mouseX - paddingLeft) / innerW));
    const pivotIndex = startIndex + rel * (barsFit - 1);
    const newBarsFit = Math.max(1, Math.floor(innerW / newPx));
    const newStart = pivotIndex - rel * (newBarsFit - 1);

    setPxPerBar(newPx);
    setOffset(clampOffset(newStart, newPx));
  };

  // Duplo clique: reset zoom para mostrar o final
  const onDoubleClick = () => {
    if (!enableNavigation) return;
    const basePx = 6;
    setPxPerBar(basePx);
    const fit = Math.max(1, Math.floor(innerW / basePx));
    const start = Math.max(0, candles.length - fit);
    setOffset(start);
  };

  // Teclado (setas, +/- e atalhos novos)
  useEffect(() => {
    if (!enableNavigation) return;
    const handler = (e: KeyboardEvent) => {
      const focused = document.activeElement as HTMLElement | null;
      if (
        focused &&
        (focused.tagName === "INPUT" || focused.tagName === "TEXTAREA")
      )
        return;

      // Fecha popovers com ESC
      if (e.key === "Escape") {
        setSelectedTrade(null);
        setSelectedCandle(null);
        return;
      }

      // Ctrl + setas: pan de meia janela
      if (e.ctrlKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        const delta = Math.floor(barsFit / 2);
        setOffset((prev) =>
          clampOffset(prev + (e.key === "ArrowRight" ? delta : -delta))
        );
        return;
      }

      // H/L pan curto; J/K zoom out/in
      if (e.key.toLowerCase() === "h") {
        setOffset((prev) =>
          clampOffset(prev - Math.max(1, Math.floor(barsFit * 0.1)))
        );
        return;
      }
      if (e.key.toLowerCase() === "l") {
        setOffset((prev) =>
          clampOffset(prev + Math.max(1, Math.floor(barsFit * 0.1)))
        );
        return;
      }
      if (e.key.toLowerCase() === "j") {
        const newPx = Math.min(36, Math.max(2, pxPerBar / 1.2));
        const pivotIndex = startIndex + (barsFit - 1);
        const newBarsFit = Math.max(1, Math.floor(innerW / newPx));
        const newStart = pivotIndex - (newBarsFit - 1);
        setPxPerBar(newPx);
        setOffset(clampOffset(newStart, newPx));
        return;
      }
      if (e.key.toLowerCase() === "k") {
        const newPx = Math.min(36, Math.max(2, pxPerBar * 1.2));
        const pivotIndex = startIndex + (barsFit - 1);
        const newBarsFit = Math.max(1, Math.floor(innerW / newPx));
        const newStart = pivotIndex - (newBarsFit - 1);
        setPxPerBar(newPx);
        setOffset(clampOffset(newStart, newPx));
        return;
      }

      // Setas padrão e +/-
      if (e.key === "ArrowLeft") {
        setOffset((prev) =>
          clampOffset(prev - Math.max(1, Math.floor(barsFit * 0.2)))
        );
      } else if (e.key === "ArrowRight") {
        setOffset((prev) =>
          clampOffset(prev + Math.max(1, Math.floor(barsFit * 0.2)))
        );
      } else if (e.key === "+" || e.key === "=") {
        const newPx = Math.min(36, Math.max(2, pxPerBar * 1.2));
        const pivotIndex = startIndex + (barsFit - 1);
        const newBarsFit = Math.max(1, Math.floor(innerW / newPx));
        const newStart = pivotIndex - (newBarsFit - 1);
        setPxPerBar(newPx);
        setOffset(clampOffset(newStart, newPx));
      } else if (e.key === "-" || e.key === "_") {
        const newPx = Math.min(36, Math.max(2, pxPerBar / 1.2));
        const pivotIndex = startIndex + (barsFit - 1);
        const newBarsFit = Math.max(1, Math.floor(innerW / newPx));
        const newStart = pivotIndex - (newBarsFit - 1);
        setPxPerBar(newPx);
        setOffset(clampOffset(newStart, newPx));
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [enableNavigation, clampOffset, pxPerBar, startIndex, barsFit, innerW]);

  // Fechar popovers ao clicar fora
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (
        !target.closest(".trade-popover") &&
        !target.closest(".candle-popover")
      ) {
        setSelectedTrade(null);
        setSelectedCandle(null);
      }
    };
    window.addEventListener("click", handler);
    return () => window.removeEventListener("click", handler);
  }, []);

  // ======= Export helpers =======
  const downloadSVG = () => {
    const svg = svgRef.current;
    if (!svg) return;
    const serializer = new XMLSerializer();
    let source = serializer.serializeToString(svg);

    // Adiciona namespace caso falte
    if (!source.match(/^<svg[^>]+xmlns=/)) {
      source = source.replace(
        /^<svg/,
        '<svg xmlns="http://www.w3.org/2000/svg"'
      );
    }
    source = '<?xml version="1.0" encoding="UTF-8"?>\n' + source;

    const blob = new Blob([source], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "candlechart.svg";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const downloadPNG = async () => {
    const svg = svgRef.current;
    if (!svg) return;
    const serializer = new XMLSerializer();
    let source = serializer.serializeToString(svg);

    if (!source.match(/^<svg[^>]+xmlns=/)) {
      source = source.replace(
        /^<svg/,
        '<svg xmlns="http://www.w3.org/2000/svg"'
      );
    }
    const svgUrl =
      "data:image/svg+xml;charset=utf-8," +
      encodeURIComponent('<?xml version="1.0" encoding="UTF-8"?>\n' + source);

    const img = new Image();
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Para evitar problemas de CORS em algumas fontes
    img.crossOrigin = "anonymous";
    img.onload = () => {
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      const pngUrl = canvas.toDataURL("image/png");
      const a = document.createElement("a");
      a.href = pngUrl;
      a.download = "candlechart.png";
      document.body.appendChild(a);
      a.click();
      a.remove();
    };
    img.src = svgUrl;
  };

  // ======= Render =======
  // Grid horizontal + labels
  const yGrid = yTicks.map((t, i) => (
    <g key={`yt-${i}`}>
      <line
        x1={paddingLeft}
        y1={yForPrice(t)}
        x2={w - paddingRight}
        y2={yForPrice(t)}
        stroke={colorGrid}
        strokeWidth={0.5}
      />
      <text
        x={paddingLeft - 8}
        y={yForPrice(t) + 3}
        textAnchor="end"
        fontSize={10}
        fill={colorText}
      >
        {t.toFixed(2)}
      </text>
    </g>
  ));

  // Candles visíveis
  const bodyW = Math.max(1, Math.floor(pxPerBar) - 2);
  const candleNodes = [];
  for (let i = startIndex; i <= endIndex; i++) {
    const c = candles[i];
    const x = xForIndex(i);
    const wickX = x;
    const o = c.open;
    const cl = c.close;
    const hi = c.high;
    const lo = c.low;
    const yOpen = yForPrice(o);
    const yClose = yForPrice(cl);
    const yHigh = yForPrice(hi);
    const yLow = yForPrice(lo);
    const isUp = cl >= o;

    const top = Math.min(yOpen, yClose);
    const heightBody = Math.max(1, Math.abs(yClose - yOpen));

    candleNodes.push(
      <g key={i}>
        {/* wick */}
        <line
          x1={wickX}
          y1={yHigh}
          x2={wickX}
          y2={yLow}
          stroke={colorWick}
          strokeWidth={1}
        />
        {/* body */}
        <rect
          x={x - bodyW / 2}
          y={top}
          width={bodyW}
          height={heightBody}
          fill={isUp ? colorBull : colorBear}
          opacity={0.9}
        />
      </g>
    );
  }

  const ema9Path = ema9.length > 0 ? emaPath(ema9) : "";
  const ema21Path = ema21.length > 0 ? emaPath(ema21) : "";

  // Fibo simples (baseado na janela visível)
  const fiboNodes =
    showFibo && endIndex - startIndex >= 2
      ? (() => {
          const slice = candles.slice(startIndex, endIndex + 1);
          const hi = Math.max(...slice.map((c) => c.high));
          const lo = Math.min(...slice.map((c) => c.low));
          const levels = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
          return (
            <g>
              {levels.map((lv, idx) => {
                const price = lo + (hi - lo) * (1 - lv);
                const y = yForPrice(price);
                return (
                  <g key={`fibo-${idx}`}>
                    <line
                      x1={paddingLeft}
                      y1={y}
                      x2={w - paddingRight}
                      y2={y}
                      stroke={darkMode ? "#444" : "#ddd"}
                      strokeDasharray="4 4"
                      strokeWidth={0.75}
                    />
                    <text
                      x={w - paddingRight}
                      y={y - 2}
                      textAnchor="end"
                      fontSize={9}
                      fill={colorText}
                    >
                      {`${(lv * 100).toFixed(1)}%`}
                    </text>
                  </g>
                );
              })}
            </g>
          );
        })()
      : null;

  // Overlay de TRADES (com clique para popover)
  const tradeNodes = tradeMarkers.map((m, idx) => (
    <g
      key={`tm-${idx}`}
      opacity={0.95}
      onClick={(e) => {
        e.stopPropagation();
        setSelectedCandle(null); // fecha candle popover
        setSelectedTrade({
          x: m.x2,
          y: m.y2,
          trade: m.trade,
          iEntry: m.iEntry,
          iExit: m.iExit,
        });
      }}
      style={{ cursor: "pointer" }}
    >
      {/* linha conectando entry->exit */}
      <line
        x1={m.x1}
        y1={m.y1}
        x2={m.x2}
        y2={m.y2}
        stroke={m.isWin ? colorBull : colorBear}
        strokeWidth={1.2}
      />
      {/* entry marker: triângulo apontando para cima/baixo conforme lado */}
      {(() => {
        const size = 5;
        const s = m.side === "SELL" ? -1 : 1;
        const points = [
          `${m.x1},${m.y1 - s * size}`,
          `${m.x1 - size},${m.y1 + s * size}`,
          `${m.x1 + size},${m.y1 + s * size}`,
        ].join(" ");
        return (
          <polygon points={points} fill={m.isWin ? colorBull : colorBear} />
        );
      })()}
      {/* exit marker: X */}
      <g
        transform={`translate(${m.x2},${m.y2})`}
        stroke={m.isWin ? colorBull : colorBear}
        strokeWidth={1.5}
      >
        <line x1={-4} y1={-4} x2={4} y2={4} />
        <line x1={-4} y1={4} x2={4} y2={-4} />
      </g>

      {/* TP/SL markers (linhas horizontais pontilhadas) */}
      {typeof m.yTP === "number" && (
        <line
          x1={Math.min(m.x1, m.x2)}
          y1={m.yTP}
          x2={Math.max(m.x1, m.x2)}
          y2={m.yTP}
          stroke={colorTP}
          strokeDasharray="3 3"
          strokeWidth={1}
        />
      )}
      {typeof m.ySL === "number" && (
        <line
          x1={Math.min(m.x1, m.x2)}
          y1={m.ySL}
          x2={Math.max(m.x1, m.x2)}
          y2={m.ySL}
          stroke={colorSL}
          strokeDasharray="3 3"
          strokeWidth={1}
        />
      )}
    </g>
  ));

  // Eixo X em 5 marcações ao longo da janela visível
  const xAxisNodes =
    candles.length > 1 ? (
      <g>
        {[0, 0.25, 0.5, 0.75, 1].map((p, i) => {
          const idx = Math.round(startIndex + p * (endIndex - startIndex));
          const x = xForIndex(idx);
          const d = new Date(candles[idx].time);
          const label =
            d.toLocaleDateString() +
            " " +
            d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
          return (
            <g key={`xt-${i}`}>
              <line
                x1={x}
                y1={h - paddingBottom}
                x2={x}
                y2={h - paddingBottom + 4}
                stroke={colorAxis}
              />
              <text
                x={x}
                y={h - 6}
                textAnchor="middle"
                fontSize={9}
                fill={colorText}
              >
                {label}
              </text>
            </g>
          );
        })}
      </g>
    ) : null;

  // Crosshair + tooltip
  const hoverNode =
    hoverIdx !== null && hoverIdx >= startIndex && hoverIdx <= endIndex
      ? (() => {
          const c = candles[hoverIdx];
          const x = xForIndex(hoverIdx);
          const y = yForPrice(c.close);
          const ema9v =
            typeof ema9[hoverIdx] === "number"
              ? (ema9[hoverIdx] as number)
              : null;
          const ema21v =
            typeof ema21[hoverIdx] === "number"
              ? (ema21[hoverIdx] as number)
              : null;
          const dt = new Date(c.time);
          const pct = ((c.close - c.open) / (c.open || 1)) * 100;

          const boxW = 200;
          const boxH = 96;
          const bx = Math.min(x + 12, w - boxW - 6);
          const by = Math.max(
            paddingTop + 4,
            Math.min(y - boxH / 2, h - paddingBottom - boxH - 4)
          );

          return (
            <g>
              {/* guia vertical */}
              <line
                x1={x}
                y1={paddingTop}
                x2={x}
                y2={h - paddingBottom}
                stroke={crosshair}
                strokeDasharray="3 3"
                strokeWidth={0.8}
              />
              {/* tooltip */}
              <rect
                x={bx}
                y={by}
                width={boxW}
                height={boxH}
                rx={8}
                ry={8}
                fill={tooltipBg}
                stroke={tooltipBd}
              />
              <text x={bx + 8} y={by + 16} fontSize={12} fill={colorText}>
                {dt.toLocaleDateString()}{" "}
                {dt.toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </text>
              <text x={bx + 8} y={by + 32} fontSize={12} fill={colorText}>
                O:{c.open.toFixed(2)} H:{c.high.toFixed(2)} L:{c.low.toFixed(2)}
              </text>
              <text x={bx + 8} y={by + 48} fontSize={12} fill={colorText}>
                C:{c.close.toFixed(2)} Δ:{(c.close - c.open).toFixed(2)} (
                {pct.toFixed(2)}%)
              </text>
              <text x={bx + 8} y={by + 64} fontSize={12} fill={colorText}>
                EMA9:{ema9v !== null ? ema9v.toFixed(2) : "—"} EMA21:
                {ema21v !== null ? ema21v.toFixed(2) : "—"}
              </text>
            </g>
          );
        })()
      : null;

  // Retângulo de seleção para zoom
  const selectionNode =
    sel.active && Math.abs(sel.x1 - sel.x0) > 2 ? (
      <rect
        x={Math.min(sel.x0, sel.x1)}
        y={paddingTop}
        width={Math.abs(sel.x1 - sel.x0)}
        height={h - paddingTop - paddingBottom}
        fill={darkMode ? "rgba(99,102,241,0.15)" : "rgba(0,123,255,0.15)"}
        stroke={darkMode ? "#6366f1" : "#0d6efd"}
        strokeWidth={1}
      />
    ) : null;

  // Cursor visual
  const cursorStyle = isPanning ? "grabbing" : "crosshair";

  // ======= Mini-mapa =======
  const miniXForIndexGlobal = (i: number) => {
    if (candles.length <= 1) return paddingLeft;
    const rel = i / (candles.length - 1);
    return paddingLeft + rel * innerW;
  };

  // escala Y global do mini-mapa
  const miniYForPrice = (() => {
    const allLows = candles.map((c) => c.low);
    const allHighs = candles.map((c) => c.high);
    const gmin = allLows.length ? Math.min(...allLows) : 0;
    const gmax = allHighs.length ? Math.max(...allHighs) : 1;
    const pad = (gmax - gmin) * 0.05 || 1;
    const minP = gmin - pad;
    const maxP = gmax + pad;
    return (p: number) =>
      miniPaddingTop +
      (1 - (p - minP) / Math.max(1e-9, maxP - minP)) * miniInnerH;
  })();

  // path linha de fechamento no mini-mapa (downsample simples)
  const miniPath = useMemo(() => {
    if (candles.length === 0) return "";
    const step = Math.max(
      1,
      Math.floor(candles.length / Math.max(100, Math.floor(innerW / 6)))
    );
    const pts: string[] = [];
    for (let i = 0; i < candles.length; i += step) {
      const x = miniXForIndexGlobal(i).toFixed(1);
      const y = miniYForPrice(candles[i].close).toFixed(1);
      pts.push(`${pts.length ? "L" : "M"} ${x} ${y}`);
    }
    // garante último ponto
    const xEnd = miniXForIndexGlobal(candles.length - 1).toFixed(1);
    const yEnd = miniYForPrice(candles[candles.length - 1].close).toFixed(1);
    pts.push(`L ${xEnd} ${yEnd}`);
    return pts.join(" ");
  }, [candles, innerW]);

  const miniWindowX = miniXForIndexGlobal(startIndex);
  const miniWindowW = Math.max(
    8,
    miniXForIndexGlobal(endIndex) - miniXForIndexGlobal(startIndex)
  );

  const onMiniMouseDown = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!enableNavigation) return;
    const rect = miniRef.current!.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const inWindow = x >= miniWindowX && x <= miniWindowX + miniWindowW;
    miniDrag.current = {
      active: true,
      startX: e.clientX,
      startOffset: offset,
    };

    if (!inWindow) {
      // clique fora: centraliza janela nesse ponto
      const rel = Math.min(1, Math.max(0, (x - paddingLeft) / innerW));
      const centerIndex = rel * (candles.length - 1);
      const newStart = centerIndex - (barsFit - 1) / 2;
      setOffset(clampOffset(newStart));
    }
  };

  const onMiniMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!enableNavigation) return;
    if (!miniDrag.current.active) return;

    const dx = e.clientX - miniDrag.current.startX;
    const barsDelta = (dx / innerW) * (candles.length - 1); // proporcional ao total
    setOffset(clampOffset(miniDrag.current.startOffset + barsDelta));
  };

  const onMiniMouseUp = () => {
    miniDrag.current.active = false;
  };

  const onMiniMouseLeave = () => {
    miniDrag.current.active = false;
  };

  const onMiniWheel = (e: React.WheelEvent<SVGSVGElement>) => {
    // zoom pelo mini-mapa (mesma lógica do principal)
    if (!enableNavigation) return;
    e.preventDefault();
    const step = Math.max(-1, Math.min(1, e.deltaY / 100));
    const zoomFactor = step < 0 ? 1.2 : 1 / 1.2;
    const newPx = Math.min(36, Math.max(2, pxPerBar * zoomFactor));

    const rect = miniRef.current?.getBoundingClientRect();
    const mouseX = rect ? e.clientX - rect.left : paddingLeft + innerW / 2;
    const rel = Math.min(1, Math.max(0, (mouseX - paddingLeft) / innerW));
    const pivotIndex = rel * (candles.length - 1);
    const newBarsFit = Math.max(1, Math.floor(innerW / newPx));
    const newStart = pivotIndex - rel * (newBarsFit - 1);

    setPxPerBar(newPx);
    setOffset(clampOffset(newStart, newPx));
  };

  // ======= Botões utilitários =======
  const goToEnd = () => {
    const fit = Math.max(1, Math.floor(innerW / Math.max(2, pxPerBar)));
    const start = Math.max(0, candles.length - fit);
    setOffset(start);
  };

  // ======= Helpers Popover =======
  const formatMinutes = (mins: number) => {
    if (!Number.isFinite(mins)) return "—";
    if (mins < 60) return `${Math.round(mins)} min`;
    const h = Math.floor(mins / 60);
    const m = Math.round(mins % 60);
    return `${h}h ${m}m`;
  };

  const goToTrade = (iTarget: number) => {
    const newStart = iTarget - (barsFit - 1) / 2;
    setOffset(clampOffset(newStart));
    setSelectedTrade(null);
  };

  // Durations calculadas para o popover de trade
  const calcDurations = (t: Trade, iEntry: number, iExit: number) => {
    const candlesDur = Math.max(0, iExit - iEntry);
    let minutesDur = NaN;
    if (t.entryTime && t.exitTime) {
      const dt =
        (new Date(t.exitTime).getTime() - new Date(t.entryTime).getTime()) /
        60000;
      minutesDur = Math.max(0, dt);
    }
    return { candlesDur, minutesDur };
  };

  // ======= Métricas do candle selecionado =======
  const renderCandlePopover = () => {
    if (!selectedCandle) return null;
    const i = selectedCandle.idx;
    const c = candles[i];
    if (!c) return null;
    const range = c.high - c.low;
    const body = Math.abs(c.close - c.open);
    const upperWick = c.high - Math.max(c.open, c.close);
    const lowerWick = Math.min(c.open, c.close) - c.low;
    const pct = ((c.close - c.open) / (c.open || 1)) * 100;
    const dt = new Date(c.time);

    return (
      <div
        className="candle-popover"
        style={{
          position: "absolute",
          top: Math.max(8, Math.min(h - 160, selectedCandle.y)),
          left: Math.max(8, Math.min(w - 220, selectedCandle.x + 10)),
          background: tooltipBg,
          border: `1px solid ${tooltipBd}`,
          borderRadius: 8,
          padding: 10,
          fontSize: 12,
          color: colorText,
          zIndex: 11,
          minWidth: 200,
          boxShadow: darkMode
            ? "0 6px 18px rgba(0,0,0,0.45)"
            : "0 6px 18px rgba(0,0,0,0.12)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ marginBottom: 6 }}>
          <b>
            {dt.toLocaleDateString()}{" "}
            {dt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </b>
        </div>
        <div>
          Open: {c.open.toFixed(2)} · High: {c.high.toFixed(2)}
        </div>
        <div>
          Low: {c.low.toFixed(2)} · Close: {c.close.toFixed(2)}
        </div>
        <div>
          Δ: {(c.close - c.open).toFixed(2)} ({pct.toFixed(2)}%)
        </div>
        <div>
          Range: {range.toFixed(2)} · Corpo: {body.toFixed(2)}
        </div>
        <div>
          Sombra sup.: {upperWick.toFixed(2)} · inf.: {lowerWick.toFixed(2)}
        </div>
        {"volume" in c && typeof c.volume === "number" && (
          <div>Volume: {c.volume}</div>
        )}
      </div>
    );
  };

  return (
    <div
      ref={wrapRef}
      style={{ width: "100%", overflow: "hidden", position: "relative" }}
    >
      {/* Barra de utilitários */}
      <div
        style={{
          display: "flex",
          gap: 8,
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 6,
          padding: "0 6px",
        }}
      >
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button
            type="button"
            onClick={goToEnd}
            style={{
              fontSize: 12,
              padding: "4px 8px",
              borderRadius: 6,
              border: `1px solid ${darkMode ? "#3f3f46" : "#ced4da"}`,
              background: darkMode ? "#0b1220" : "#fff",
              color: darkMode ? "#e5e7eb" : "#212529",
              cursor: "pointer",
            }}
            title="Ir para os candles mais recentes"
          >
            Ir para o fim
          </button>

          <button
            type="button"
            onClick={downloadSVG}
            style={{
              fontSize: 12,
              padding: "4px 8px",
              borderRadius: 6,
              border: `1px solid ${darkMode ? "#3f3f46" : "#ced4da"}`,
              background: darkMode ? "#0b1220" : "#fff",
              color: darkMode ? "#e5e7eb" : "#212529",
              cursor: "pointer",
            }}
            title="Exportar gráfico como SVG"
          >
            Exportar SVG
          </button>

          <button
            type="button"
            onClick={downloadPNG}
            style={{
              fontSize: 12,
              padding: "4px 8px",
              borderRadius: 6,
              border: `1px solid ${darkMode ? "#3f3f46" : "#ced4da"}`,
              background: darkMode ? "#0b1220" : "#fff",
              color: darkMode ? "#e5e7eb" : "#212529",
              cursor: "pointer",
            }}
            title="Exportar gráfico como PNG"
          >
            Exportar PNG
          </button>
        </div>

        <small style={{ color: darkMode ? "#94a3b8" : "#6c757d" }}>
          Dica: arraste para <b>mover</b> · <b>Shift+arraste</b> para{" "}
          <b>selecionar e dar zoom</b> · <b>Scroll</b> para zoom ·{" "}
          <b>Duplo clique</b> para resetar · <b>H/L</b> pan · <b>J/K</b> zoom ·{" "}
          <b>Ctrl+←/→</b> meia janela
        </small>
      </div>

      {/* Gráfico principal */}
      <svg
        ref={svgRef}
        width={w}
        height={h}
        role="img"
        aria-label="Candle chart"
        style={{
          touchAction: "none",
          userSelect: "none",
          background: "transparent",
          cursor: cursorStyle,
        }}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseLeave={onMouseLeave}
        onMouseUp={onMouseUp}
        onWheel={onWheel}
        onDoubleClick={onDoubleClick}
        onClick={onClickMain}
      >
        {/* GRID + EIXO Y */}
        {yGrid}

        {/* CANDLES */}
        {candleNodes}

        {/* EMAs */}
        {ema9Path && (
          <path
            d={ema9Path}
            fill="none"
            stroke={colorEma9}
            strokeWidth={1.25}
          />
        )}
        {ema21Path && (
          <path
            d={ema21Path}
            fill="none"
            stroke={colorEma21}
            strokeWidth={1.5}
          />
        )}

        {/* Fibo */}
        {fiboNodes}

        {/* TRADES */}
        {tradeNodes}

        {/* EIXO X */}
        {xAxisNodes}

        {/* Seleção e hover */}
        {selectionNode}
        {hoverNode}
      </svg>

      {/* Mini-mapa */}
      <svg
        ref={miniRef}
        width={w}
        height={miniH}
        role="img"
        aria-label="Mini-mapa"
        style={{
          touchAction: "none",
          userSelect: "none",
          background: "transparent",
          marginTop: 6,
          cursor: miniDrag.current.active ? "grabbing" : "pointer",
        }}
        onMouseDown={onMiniMouseDown}
        onMouseMove={onMiniMouseMove}
        onMouseUp={onMiniMouseUp}
        onMouseLeave={onMiniMouseLeave}
        onWheel={onMiniWheel}
      >
        {/* Fundo e eixo */}
        <rect
          x={paddingLeft}
          y={miniPaddingTop}
          width={innerW}
          height={miniInnerH}
          fill={darkMode ? "rgba(148,163,184,0.06)" : "rgba(0,0,0,0.03)"}
          stroke={darkMode ? "#3f3f46" : "#e9ecef"}
        />

        {/* Close line path */}
        {miniPath && (
          <path d={miniPath} fill="none" stroke={miniLine} strokeWidth={1} />
        )}

        {/* Janela visível */}
        <rect
          x={miniWindowX}
          y={miniPaddingTop}
          width={miniWindowW}
          height={miniInnerH}
          fill={miniWindow}
          stroke={miniWindowBorder}
          strokeWidth={1}
        />
      </svg>

      {/* ======= Popover de Trade ======= */}
      {selectedTrade && (
        <div
          className="trade-popover"
          style={{
            position: "absolute",
            top: Math.max(8, Math.min(h - 120, selectedTrade.y)),
            left: Math.max(8, Math.min(w - 220, selectedTrade.x + 10)),
            background: tooltipBg,
            border: `1px solid ${tooltipBd}`,
            borderRadius: 8,
            padding: 10,
            fontSize: 12,
            color: colorText,
            zIndex: 10,
            minWidth: 200,
            boxShadow: darkMode
              ? "0 6px 18px rgba(0,0,0,0.45)"
              : "0 6px 18px rgba(0,0,0,0.12)",
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {(() => {
            const t = selectedTrade.trade;
            const { candlesDur, minutesDur } = calcDurations(
              t,
              selectedTrade.iEntry,
              selectedTrade.iExit
            );
            return (
              <>
                <div style={{ marginBottom: 6 }}>
                  <b>{t.side || "—"}</b>{" "}
                  <span style={{ opacity: 0.7 }}>
                    {t.entryTime ? new Date(t.entryTime).toLocaleString() : "—"}{" "}
                    → {t.exitTime ? new Date(t.exitTime).toLocaleString() : "—"}
                  </span>
                </div>
                <div>
                  Entrada:{" "}
                  {typeof t.entryPrice === "number"
                    ? t.entryPrice.toFixed(2)
                    : "—"}
                </div>
                <div>
                  Saída:{" "}
                  {typeof t.exitPrice === "number"
                    ? t.exitPrice.toFixed(2)
                    : "—"}
                </div>
                <div>
                  PnL: {typeof t.pnlPoints === "number" ? t.pnlPoints : "—"} pts
                  {typeof t.pnl === "number"
                    ? ` · R$: ${t.pnl.toFixed(2)}`
                    : ""}
                </div>
                <div>Motivo: {t.exitReason || "—"}</div>
                <div>
                  Duração: {candlesDur} candles · {formatMinutes(minutesDur)}
                </div>
                <button
                  onClick={() => goToTrade(selectedTrade.iEntry)}
                  style={{
                    marginTop: 8,
                    padding: "4px 8px",
                    borderRadius: 6,
                    border: `1px solid ${darkMode ? "#3f3f46" : "#ced4da"}`,
                    background: darkMode ? "#0b1220" : "#f8f9fa",
                    color: colorText,
                    cursor: "pointer",
                  }}
                  title="Centralizar janela neste trade"
                >
                  Ir para o trade
                </button>
              </>
            );
          })()}
        </div>
      )}

      {/* ======= Popover de Candle ======= */}
      {renderCandlePopover()}
    </div>
  );
}
