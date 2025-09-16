import React from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Navbar,
  Container,
  Row,
  Col,
  Form,
  Button,
  Spinner,
  Card,
  Badge,
  Alert,
  Tabs,
  Tab,
} from "react-bootstrap";
import ImportProgress from "../components/ImportProgress";
import CandleChart from "../components/CandleChart";
import SignalsTable from "../components/SignalsTable";
import ProjectedSignalsTable from "../components/ProjectedSignalsTable";
import PnLSummary from "../components/PnLSummary";
import EquityBars from "../components/EquityBars";
import EquityCurve from "../components/EquityCurve";
import WinrateHeatmap from "../components/WinrateHeatmap";
import { api } from "../services/api";
import { toCSV, downloadCSV } from "../utils/csv";
import "../styles/dashboard.css";

type Candle = {
  time: string;
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

type Projected = {
  time?: string | null;
  date?: string | null;
  side?: "BUY" | "SELL" | "FLAT" | string | null;
  suggestedEntry?: number | null;
  stopSuggestion?: number | null;
  takeProfitSuggestion?: number | null;
  conditionText?: string | null;
  score?: number | null;
  probHit?: number | null;
  probCalibrated?: number | null;
  expectedValuePoints?: number | null;
  // opcionalmente presentes no backend:
  vwapOk?: boolean;
  ev?: number | null;
  expectedValue?: number | null;
  expected_value?: number | null;
  prob?: number | null;
};

const LS_KEY = "dtia.settings.v6";         // bump forte
const LS_MIGRATED_FLAG = "dtia.migrated.v6";

/* ====== util para data de hoje (local) no formato YYYY-MM-DD ====== */
function todayLocalISO() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function todayRange() {
  const t = todayLocalISO();
  return { from: t, to: t };
}
function todayISO() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

/* ====== EMA simples para plot ====== */
function emaSeries(values: number[], period: number): (number | null)[] {
  if (!Array.isArray(values) || values.length === 0 || period <= 1) {
    return values.map(() => null);
  }
  const out: (number | null)[] = [];
  const k = 2 / (period + 1);
  let e: number | null = null;
  for (let i = 0; i < values.length; i++) {
    const v = Number(values[i]) || 0;
    e = e == null ? v : v * k + (e as number) * (1 - k);
    out.push(e);
  }
  return out;
}

/* ====== NOVO: range com offset local (para alinhar com backend) ====== */
function localOffsetStr() {
  const offMin = new Date().getTimezoneOffset(); // minutos atrás do UTC
  const sign = offMin > 0 ? "-" : "+";
  const abs = Math.abs(offMin);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${sign}${hh}:${mm}`;
}
function toZonedRange(fromDate?: string, toDate?: string) {
  const off = localOffsetStr();
  const fromZ = fromDate ? `${fromDate}T00:00:00${off}` : undefined;
  const toZ = toDate ? `${toDate}T23:59:59.999${off}` : undefined;
  return { fromZ, toZ };
}

export default function Dashboard() {
  const [symbol, setSymbol] = useState("WIN");
  const [timeframe, setTimeframe] = useState("M5");
  const [dateFrom, setDateFrom] = useState<string>(() => todayISO());
  const [dateTo, setDateTo] = useState<string>(() => todayISO());

  const [loading, setLoading] = useState(false);
  const [candles, setCandles] = useState<Candle[]>([]);
  const [signals, setSignals] = useState<any[]>([]);
  const [projected, setProjected] = useState<Projected[]>([]);
  const [pnl, setPnL] = useState<any>({ pnlPoints: 0, pnlMoney: 0 });

  const [ema9, setEma9] = useState<(number | null)[]>([]);
  const [ema21, setEma21] = useState<(number | null)[]>([]);
  const [showFibo, setShowFibo] = useState(true);
  const [realtime, setRealtime] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [darkMode, setDarkMode] = useState<boolean>(false);

  // Filtro por horário
  const [applyHourFilter, setApplyHourFilter] = useState<boolean>(false);
  const [hourStart, setHourStart] = useState<number>(9);
  const [hourEnd, setHourEnd] = useState<number>(17);

  // Filtro por VWAP (lado-sensível)
  const [vwapFilter, setVwapFilter] = useState<boolean>(false);

  // Tabelas
  const [showColsConfirmed] = useState({
    date: true,
    time: true,
    side: true,
    type: true,
    price: true,
    score: true,
    reason: true,
  });
  const [showColsProjected] = useState({
    date: true,
    time: true,
    side: true,
    entry: true,
    stop: true,
    take: true,
    prob: true,
    ev: true,
    condition: true,
    score: true,
  });

  // Parâmetros preditivos
  const [horizon, setHorizon] = useState<number>(8);
  const [rr, setRR] = useState<number>(2);
  const [evalWindow, setEvalWindow] = useState<number>(200);
  const [gateRegime, setGateRegime] = useState<boolean>(true);
  const [gateToD, setGateToD] = useState<boolean>(true);
  const [calibrate, setCalibrate] = useState<boolean>(true);
  const [useMicroModel, setUseMicroModel] = useState<boolean>(false);
  const [minProb, setMinProb] = useState<number>(0);
  const [minEV, setMinEV] = useState<number>(0);
  const [dailyLossCap, setDailyLossCap] = useState<number>(0);

  // Carrega valores do localStorage ao montar
  useEffect(() => {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return; // mantém HOJE

      const s = JSON.parse(raw);
      if (s.symbol) setSymbol(s.symbol);
      if (s.timeframe) setTimeframe(s.timeframe);

      // não restaura datas para manter Hoje→Hoje
      if (typeof s.showFibo === "boolean") setShowFibo(s.showFibo);
      if (typeof s.darkMode === "boolean") setDarkMode(s.darkMode);
      if (typeof s.horizon === "number") setHorizon(s.horizon);
      if (typeof s.rr === "number") setRR(s.rr);
      if (typeof s.evalWindow === "number") setEvalWindow(s.evalWindow);
      if (typeof s.gateRegime === "boolean") setGateRegime(s.gateRegime);
      if (typeof s.gateToD === "boolean") setGateToD(s.gateToD);
      if (typeof s.calibrate === "boolean") setCalibrate(s.calibrate);
      if (typeof s.useMicroModel === "boolean") setUseMicroModel(s.useMicroModel);
      if (typeof s.minProb === "number") setMinProb(s.minProb);
      if (typeof s.minEV === "number") setMinEV(s.minEV);
      if (typeof s.dailyLossCap === "number") setDailyLossCap(s.dailyLossCap);
      if (typeof s.applyHourFilter === "boolean") setApplyHourFilter(s.applyHourFilter);
      if (typeof s.hourStart === "number") setHourStart(s.hourStart);
      if (typeof s.hourEnd === "number") setHourEnd(s.hourEnd);
      if (typeof s.vwapFilter === "boolean") setVwapFilter(s.vwapFilter);

      // limpa datas antigas do storage
      if ("dateFrom" in s || "dateTo" in s) {
        const { dateFrom: _df, dateTo: _dt, ...rest } = s;
        try { localStorage.setItem(LS_KEY, JSON.stringify(rest)); } catch { }
      }
    } catch { }
  }, []);

  // Garantia extra: se alguma data estiver vazia, seta HOJE
  useEffect(() => {
    if (!dateFrom || !dateTo) {
      const t = todayISO();
      if (!dateFrom) setDateFrom(t);
      if (!dateTo) setDateTo(t);
    }
  }, [dateFrom, dateTo]);

  // Persiste filtros/parâmetros
  useEffect(() => {
    const payload = {
      symbol,
      timeframe,
      dateFrom,
      dateTo,
      showFibo,
      darkMode,
      horizon,
      rr,
      evalWindow,
      gateRegime,
      gateToD,
      calibrate,
      useMicroModel,
      minProb,
      minEV,
      dailyLossCap,
      applyHourFilter,
      hourStart,
      hourEnd,
      vwapFilter,
    };
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(payload));
    } catch { }
  }, [
    symbol,
    timeframe,
    dateFrom,
    dateTo,
    showFibo,
    darkMode,
    horizon,
    rr,
    evalWindow,
    gateRegime,
    gateToD,
    calibrate,
    useMicroModel,
    minProb,
    minEV,
    dailyLossCap,
    applyHourFilter,
    hourStart,
    hourEnd,
    vwapFilter,
  ]);

  // Tema
  useEffect(() => {
    document.body.classList.toggle("theme-dark", darkMode);
    return () => document.body.classList.remove("theme-dark");
  }, [darkMode]);

  // === Range com offset local (ALINHAMENTO) ===
  const { fromZ, toZ } = useMemo(
    () => toZonedRange(dateFrom, dateTo),
    [dateFrom, dateTo]
  );

  // Params base para GET /candles e /signals
  const params = useMemo(
    () => ({
      symbol: symbol.toUpperCase(),
      timeframe: timeframe.toUpperCase(),
      from: fromZ, // com offset local
      to: toZ,     // com offset local
    }),
    [symbol, timeframe, fromZ, toZ]
  );

  // EMA para o gráfico
  useEffect(() => {
    if (!candles?.length) {
      setEma9([]);
      setEma21([]);
      return;
    }
    const closes = candles.map((c) => Number(c.close) || 0);
    setEma9(emaSeries(closes, 9));
    setEma21(emaSeries(closes, 21));
  }, [candles]);

  const loadAll = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      // Candles (gráfico)
      const cc = await api.get("/candles", { params });
      setCandles(cc.data ?? []);

      // Sinais confirmados
      const ss = await api.get("/signals", { params });
      const sig =
        Array.isArray(ss.data)
          ? ss.data
          : Array.isArray(ss.data?.signals)
            ? ss.data.signals
            : Array.isArray(ss.data?.data)
              ? ss.data.data
              : [];
      setSignals(sig);

      // Projetados (IA + heurística, com filtros/gates)
      const pp = await api.post("/signals/projected", {
        symbol,
        timeframe,
        from: fromZ,
        to: toZ,
        horizon,
        rr,
        evalWindow,
        regime: gateRegime ? 1 : 0,
        tod: gateToD ? 1 : 0,
        adaptive: 1,
        cooldown: 1,
        conformal: calibrate ? 1 : 0,
        useMicroModel: useMicroModel ? 1 : 0,
        minEV: Number(minEV) || 0,
        lossCap: Number(dailyLossCap) || 0,
        minProb: Number(minProb) || 0,
        vwapFilter: vwapFilter ? 1 : 0, // lado-sensível
      });
      const proj = Array.isArray(pp.data)
        ? pp.data
        : Array.isArray(pp.data?.projected)
          ? pp.data.projected
          : Array.isArray(pp.data?.data)
            ? pp.data.data
            : [];
      setProjected(proj);

      // Backtest (trades) — agora também recebe os mesmos gates para “casar” com Projetados
      const bt = await api.post("/backtest", {
        symbol,
        timeframe,
        from: fromZ,
        to: toZ,
        lossCap: Number(dailyLossCap) || 0,
        // se o backend não usar, ele ignora:
        minProb: Number(minProb) || 0,
        minEV: Number(minEV) || 0,
        useMicroModel: useMicroModel ? 1 : 0,
        vwapFilter: vwapFilter ? 1 : 0,
      });
      setPnL(bt.data ?? { pnlPoints: 0, pnlMoney: 0 });
    } catch (e: any) {
      setError(e?.message || "Falha ao carregar dados");
      setCandles([]);
      setSignals([]);
      setProjected([]);
      setPnL({ pnlPoints: 0, pnlMoney: 0 });
    } finally {
      setLoading(false);
    }
  }, [
    symbol,
    timeframe,
    fromZ,
    toZ,
    horizon,
    rr,
    evalWindow,
    gateRegime,
    gateToD,
    calibrate,
    useMicroModel,
    minProb,
    minEV,
    dailyLossCap,
    vwapFilter,
    params,
  ]);

  // Carrega quando as dependências mudarem
  useEffect(() => {
    if (fromZ && toZ) loadAll();
  }, [loadAll, fromZ, toZ]);

  // Polling quando “Realtime” estiver ON
  useEffect(() => {
    if (!realtime) return;
    const id = setInterval(() => {
      loadAll();
    }, 10000);
    return () => clearInterval(id);
  }, [realtime, loadAll]);

  // ---- util de PnL/trades
  const allTrades = useMemo(
    () => (pnl?.trades || pnl?.tradeList || []) as any[],
    [pnl]
  );

  const filterByHour = useCallback(
    (trades: any[]) => {
      if (!applyHourFilter) return trades;
      const start = Math.max(0, Math.min(23, Number(hourStart) || 0));
      const end = Math.max(0, Math.min(23, Number(hourEnd) || 0));
      const inRange = (h: number) => {
        if (start <= end) return h >= start && h <= end;
        return h >= start || h <= end; // faixa cruzando meia-noite
      };
      return trades.filter((t) => {
        const d = t?.entryTime ? new Date(t.entryTime) : null;
        const hr = d ? d.getHours() : null;
        if (hr === null) return false;
        return inRange(hr);
      });
    },
    [applyHourFilter, hourStart, hourEnd]
  );

  const tradesFiltered = useMemo(
    () => filterByHour(allTrades),
    [allTrades, filterByHour]
  );

  // ---- exportações CSV
  const exportSignals = () => {
    const csv = toCSV(
      (signals || []).map((s: any) => ({
        time: s.time,
        date: s.date,
        type: s.signalType,
        side: s.side,
        price: s.price,
        reason: s.reason,
        score: s.score,
      })),
      ["time", "date", "type", "side", "price", "reason", "score"]
    );
    downloadCSV(
      `confirmed_${symbol}_${timeframe}_${dateFrom}_${dateTo}.csv`,
      csv
    );
  };

  const exportProjected = () => {
    const csv = toCSV(
      (projected || []).map((p: any) => ({
        time: p.time,
        date: p.date,
        side: p.side,
        entry: p.suggestedEntry,
        stop: p.stopSuggestion,
        take: p.takeProfitSuggestion,
        condition: p.conditionText,
        score: p.score,
        prob: p.probCalibrated ?? p.probHit ?? p.prob,
        ev_points:
          p.expectedValuePoints ??
          p.ev ??
          p.expectedValue ??
          p.expected_value,
        vwap_ok: typeof p.vwapOk === "boolean" ? (p.vwapOk ? 1 : 0) : "",
      })),
      [
        "time",
        "date",
        "side",
        "entry",
        "stop",
        "take",
        "condition",
        "score",
        "prob",
        "ev_points",
        "vwap_ok",
      ]
    );
    downloadCSV(
      `projected_${symbol}_${timeframe}_${dateFrom}_${dateTo}.csv`,
      csv
    );
  };

  const exportTrades = () => {
    const csv = toCSV(
      (allTrades as any[]).map((t: any) => ({
        side: t.side,
        entryTime: t.entryTime,
        entryPrice: t.entryPrice,
        exitTime: t.exitTime,
        exitPrice: t.exitPrice,
        pnlPoints: t.pnlPoints ?? t.pnl,
      })),
      ["side", "entryTime", "entryPrice", "exitTime", "exitPrice", "pnlPoints"]
    );
    downloadCSV(`trades_${symbol}_${timeframe}_${dateFrom}_${dateTo}.csv`, csv);
  };

  // ---- CSV Resumo (inclui ties e profitFactor)
  function computeSummaryFromTrades(tradesArr: any[]) {
    const toPts = (t: any) =>
      typeof t.pnlPoints === "number"
        ? t.pnlPoints
        : typeof t.pnl === "number"
          ? t.pnl
          : 0;
    const total = tradesArr.length;
    const pnlPoints = tradesArr.reduce((acc, t) => acc + toPts(t), 0);
    const wins = tradesArr.filter((t) => toPts(t) > 0).length;
    const losses = tradesArr.filter((t) => toPts(t) < 0).length;
    const ties = tradesArr.filter((t) => toPts(t) === 0).length;
    const avgPnL = total ? pnlPoints / total : 0;
    const grossProfit = tradesArr
      .filter((t) => toPts(t) > 0)
      .reduce((a, t) => a + toPts(t), 0);
    const grossLoss = tradesArr
      .filter((t) => toPts(t) < 0)
      .reduce((a, t) => a + toPts(t), 0);
    const profitFactor =
      grossLoss !== 0
        ? grossProfit / Math.abs(grossLoss)
        : grossProfit > 0
          ? Infinity
          : 0;

    return {
      trades: total,
      wins,
      losses,
      ties,
      winRate: total ? (wins / total) * 100 : 0,
      pnlPoints,
      avgPnL,
      profitFactor,
    };
  }

  const exportSummary = () => {
    const tradesArr = allTrades as any[];
    const summary =
      (pnl?.summary &&
        typeof pnl.summary === "object" &&
        !Array.isArray(pnl.summary)
        ? pnl.summary
        : computeSummaryFromTrades(tradesArr)) || {};
    const row = {
      symbol,
      timeframe,
      from: dateFrom,
      to: dateTo,
      trades: summary.trades ?? tradesArr.length,
      wins: summary.wins ?? 0,
      losses: summary.losses ?? 0,
      ties: summary.ties ?? 0,
      winRate: summary.winRate ?? 0,
      pnlPoints:
        summary.pnlPoints ??
        tradesArr.reduce(
          (a: number, t: any) => a + (t.pnlPoints ?? t.pnl ?? 0),
          0
        ),
      avgPnL: summary.avgPnL ?? 0,
      profitFactor:
        summary.profitFactor === Infinity
          ? "Infinity"
          : summary.profitFactor ?? 0,
    };
    const csv = toCSV(
      [row],
      [
        "symbol",
        "timeframe",
        "from",
        "to",
        "trades",
        "wins",
        "losses",
        "ties",
        "winRate",
        "pnlPoints",
        "avgPnL",
        "profitFactor",
      ]
    );
    downloadCSV(
      `summary_${symbol}_${timeframe}_${dateFrom}_${dateTo}.csv`,
      csv
    );
  };

  // ---- CSV PF/WR por hora (0..23)
  const exportHourlyStats = () => {
    const rows: Array<{
      hour: number;
      total: number;
      wins: number;
      losses: number;
      ties: number;
      winRate: number;
      grossProfitPts: number;
      grossLossPts: number;
      profitFactor: number | string;
      avgPnL: number;
    }> = [];

    const buckets: Record<
      number,
      {
        total: number;
        wins: number;
        losses: number;
        ties: number;
        gp: number;
        gl: number;
      }
    > = {};

    const toPts = (t: any) =>
      typeof t.pnlPoints === "number"
        ? t.pnlPoints
        : typeof t.pnl === "number"
          ? t.pnl
          : 0;

    for (let h = 0; h < 24; h++) {
      buckets[h] = { total: 0, wins: 0, losses: 0, ties: 0, gp: 0, gl: 0 };
    }

    (allTrades as any[]).forEach((t) => {
      const d = t?.entryTime ? new Date(t.entryTime) : null;
      const hr = d ? d.getHours() : null;
      if (hr === null) return;
      const pts = toPts(t);
      const b = buckets[hr];
      b.total += 1;
      if (pts > 0) {
        b.wins += 1;
        b.gp += pts;
      } else if (pts < 0) {
        b.losses += 1;
        b.gl += pts;
      } else {
        b.ties += 1;
      }
    });

    for (let h = 0; h < 24; h++) {
      const b = buckets[h];
      const wr = b.total ? (b.wins / b.total) * 100 : 0;
      const pf = b.gl !== 0 ? b.gp / Math.abs(b.gl) : b.gp > 0 ? "Infinity" : 0;
      const avg = b.total ? (b.gp + b.gl) / b.total : 0;
      rows.push({
        hour: h,
        total: b.total,
        wins: b.wins,
        losses: b.losses,
        ties: b.ties,
        winRate: Number(wr.toFixed(2)),
        grossProfitPts: Number(b.gp.toFixed(2)),
        grossLossPts: Number(b.gl.toFixed(2)),
        profitFactor:
          typeof pf === "number" ? Number((pf as number).toFixed(3)) : pf,
        avgPnL: Number(avg.toFixed(3)),
      });
    }

    const csv = toCSV(rows, [
      "hour",
      "total",
      "wins",
      "losses",
      "ties",
      "winRate",
      "grossProfitPts",
      "grossLossPts",
      "profitFactor",
      "avgPnL",
    ]);
    downloadCSV(
      `hourly_stats_${symbol}_${timeframe}_${dateFrom}_${dateTo}.csv`,
      csv
    );
  };

  // ---- UI
  return (
    <div className="dash-wrapper">
      <Navbar className="mb-3 dash-navbar">
        <Container>
          {/* Import progress */}
          <Row className="mb-3">
            <Col>
              <ImportProgress />
            </Col>
          </Row>

          <Navbar.Brand className="fw-bold">DayTrade IA</Navbar.Brand>
          <div className="d-flex align-items-center gap-2 ms-auto">
            <Form.Check
              type="switch"
              label="Dark"
              checked={darkMode}
              onChange={(e) => setDarkMode(e.currentTarget.checked)}
            />
            <Form.Check
              type="switch"
              label="Realtime"
              checked={realtime}
              onChange={(e) => setRealtime(e.currentTarget.checked)}
            />
          </div>
        </Container>
      </Navbar>

      <Container>
        {error && (
          <Alert variant="danger">
            <div className="d-flex align-items-center gap-2">
              <Badge bg="danger">Erro</Badge>
              <div>{error}</div>
            </div>
          </Alert>
        )}

        {/* Filtros */}
        <Card className="shadow-sm mb-3 elevated-card filter-card">
          <Card.Body>
            <Row className="gy-2 align-items-end">
              <Col sm={2}>
                <Form.Label>Ativo</Form.Label>
                <Form.Control
                  value={symbol}
                  onChange={(e) => setSymbol(e.target.value.toUpperCase())}
                  placeholder="WIN"
                />
              </Col>
              <Col sm={2}>
                <Form.Label>Timeframe</Form.Label>
                <Form.Select
                  value={timeframe}
                  onChange={(e) => setTimeframe(e.currentTarget.value)}
                >
                  <option value="M1">M1</option>
                  <option value="M5">M5</option>
                  <option value="M15">M15</option>
                  <option value="M30">M30</option>
                  <option value="H1">H1</option>
                </Form.Select>
              </Col>
              <Col sm={2}>
                <Form.Label>De</Form.Label>
                <Form.Control
                  type="date"
                  value={dateFrom}
                  onChange={(e) => setDateFrom(e.target.value)}
                />
              </Col>
              <Col sm={2}>
                <Form.Label>Até</Form.Label>
                <Form.Control
                  type="date"
                  value={dateTo}
                  onChange={(e) => setDateTo(e.target.value)}
                />
              </Col>

              <Col sm={4} className="text-end">
                <Button onClick={loadAll} disabled={loading}>
                  {loading ? (
                    <>
                      <Spinner size="sm" animation="border" className="me-2" />
                      Carregando…
                    </>
                  ) : (
                    "Atualizar"
                  )}
                </Button>
              </Col>
            </Row>

            {/* Filtro por horário */}
            <Row className="gy-2 align-items-end mt-2">
              <Col sm={3}>
                <Form.Check
                  type="switch"
                  label="Aplicar filtro por horário (entrada)"
                  checked={applyHourFilter}
                  onChange={(e) => setApplyHourFilter(e.currentTarget.checked)}
                />
              </Col>
              <Col sm={2}>
                <Form.Label>Hora início</Form.Label>
                <Form.Control
                  type="number"
                  min={0}
                  max={23}
                  value={hourStart}
                  onChange={(e) =>
                    setHourStart(
                      Math.max(0, Math.min(23, Number(e.target.value) || 0))
                    )
                  }
                />
              </Col>
              <Col sm={2}>
                <Form.Label>Hora fim</Form.Label>
                <Form.Control
                  type="number"
                  min={0}
                  max={23}
                  value={hourEnd}
                  onChange={(e) =>
                    setHourEnd(
                      Math.max(0, Math.min(23, Number(e.target.value) || 0))
                    )
                  }
                />
              </Col>
              <Col sm={3}>
                {/* Filtro por VWAP lado-sensível */}
                <Form.Check
                  type="switch"
                  label="Filtrar por VWAP (lado)"
                  checked={vwapFilter}
                  onChange={(e) => setVwapFilter(e.currentTarget.checked)}
                />
              </Col>
              <Col sm={2} className="text-end">
                <div className="text-muted small">
                  Dica: use o heatmap abaixo para escolher as horas mais fortes.
                </div>
              </Col>
            </Row>
          </Card.Body>
        </Card>

        {/* Painel principal */}
        <Row className="g-3">
          <Col lg={8}>
            <Card className="shadow-sm elevated-card">
              <Card.Header className="d-flex align-items-center justify-content-between">
                <div className="fw-semibold">Gráfico</div>
                <div className="d-flex align-items-center gap-2">
                  <Form.Check
                    type="switch"
                    label="EMA"
                    checked={true}
                    onChange={() => { }}
                    disabled
                  />
                  <Form.Check
                    type="switch"
                    label="Fibo"
                    checked={showFibo}
                    onChange={(e) => setShowFibo(e.currentTarget.checked)}
                  />
                </div>
              </Card.Header>
              <Card.Body style={{ minHeight: 300 }}>
                <CandleChart
                  candles={candles}
                  ema9={ema9}
                  ema21={ema21}
                  showFibo={showFibo}
                  darkMode={darkMode}
                  trades={tradesFiltered as any[]}
                />
              </Card.Body>
            </Card>

            <Card className="shadow-sm elevated-card mt-3">
              <Card.Header className="d-flex align-items-center justify-content-between">
                <div className="fw-semibold">Sinais</div>
                <div className="d-flex align-items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline-primary"
                    onClick={exportSignals}
                  >
                    CSV Confirmados
                  </Button>
                  <Button
                    size="sm"
                    variant="outline-secondary"
                    onClick={exportProjected}
                  >
                    CSV Projetados
                  </Button>
                </div>
              </Card.Header>
              <Card.Body>
                <Tabs defaultActiveKey="confirmed" className="mb-2">
                  <Tab eventKey="confirmed" title="Confirmados">
                    <SignalsTable
                      items={signals}
                      visibleCols={showColsConfirmed}
                    />
                  </Tab>
                  <Tab eventKey="projected" title="Projetados">
                    <ProjectedSignalsTable
                      items={projected}
                      visibleCols={showColsProjected}
                    />
                  </Tab>
                </Tabs>
              </Card.Body>
            </Card>
          </Col>

          <Col lg={4}>
            <Card className="shadow-sm elevated-card">
              <Card.Header className="d-flex align-items-center justify-content-between">
                <div className="fw-semibold">PnL & Estatísticas</div>
                <div className="d-flex align-items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline-secondary"
                    onClick={exportSummary}
                  >
                    CSV Resumo
                  </Button>
                  <Button
                    size="sm"
                    variant="outline-secondary"
                    onClick={exportTrades}
                  >
                    CSV Trades
                  </Button>
                </div>
              </Card.Header>
              <Card.Body className="d-flex flex-column gap-2">
                <PnLSummary
                  pnlPoints={pnl?.pnlPoints}
                  pnlMoney={pnl?.pnlMoney}
                  result={pnl}
                />
                <EquityBars trades={tradesFiltered as any[]} bucket="day" />
              </Card.Body>
            </Card>

            <div className="mt-3">
              <EquityCurve
                trades={tradesFiltered as any[]}
                darkMode={darkMode}
              />
            </div>

            <div className="mt-3">
              <Card className="shadow-sm">
                <Card.Header className="d-flex align-items-center justify-content-between">
                  <span className="fw-semibold">Heatmap por Hora</span>
                  <Button
                    size="sm"
                    variant="outline-secondary"
                    onClick={exportHourlyStats}
                  >
                    CSV PF/WR por hora
                  </Button>
                </Card.Header>
                <Card.Body>
                  <WinrateHeatmap
                    trades={allTrades as any[]}
                    darkMode={darkMode}
                  />
                </Card.Body>
              </Card>
            </div>

            {/* Parâmetros de projeção */}
            <Card className="shadow-sm elevated-card mt-3">
              <Card.Header className="fw-semibold">
                Parâmetros de Projeção
              </Card.Header>
              <Card.Body>
                <Row className="gy-2">
                  <Col sm={6}>
                    <Form.Label>Horizonte (barras)</Form.Label>
                    <Form.Control
                      type="number"
                      value={horizon}
                      onChange={(e) => setHorizon(Number(e.target.value) || 0)}
                      min={1}
                    />
                  </Col>
                  <Col sm={6}>
                    <Form.Label>R:R</Form.Label>
                    <Form.Control
                      type="number"
                      value={rr}
                      onChange={(e) => setRR(Number(e.target.value) || 0)}
                      min={0.5}
                      step={0.5}
                    />
                  </Col>
                  <Col sm={6}>
                    <Form.Label>Janela (eval)</Form.Label>
                    <Form.Control
                      type="number"
                      value={evalWindow}
                      onChange={(e) =>
                        setEvalWindow(Number(e.target.value) || 0)
                      }
                      min={50}
                    />
                  </Col>
                  <Col sm={6}>
                    <Form.Label>Prob mín</Form.Label>
                    <Form.Control
                      type="number"
                      value={minProb}
                      onChange={(e) => setMinProb(Number(e.target.value) || 0)}
                      min={0}
                      max={1}
                      step={0.01}
                    />
                  </Col>
                  <Col sm={6}>
                    <Form.Label>EV (pts) mín</Form.Label>
                    <Form.Control
                      type="number"
                      value={minEV}
                      onChange={(e) => setMinEV(Number(e.target.value) || 0)}
                      min={0}
                      step={0.1}
                    />
                  </Col>
                  <Col sm={6}>
                    <Form.Label>Loss diário (cap)</Form.Label>
                    <Form.Control
                      type="number"
                      value={dailyLossCap}
                      onChange={(e) =>
                        setDailyLossCap(Number(e.target.value) || 0)
                      }
                      min={0}
                    />
                  </Col>

                  <Col xs={12} className="mt-2">
                    <div className="d-flex align-items-center gap-3 flex-wrap">
                      <Form.Check
                        type="switch"
                        label="Regime (MTF)"
                        checked={gateRegime}
                        onChange={(e) => setGateRegime(e.currentTarget.checked)}
                      />
                      <Form.Check
                        type="switch"
                        label="Time-of-Day"
                        checked={gateToD}
                        onChange={(e) => setGateToD(e.currentTarget.checked)}
                      />
                      <Form.Check
                        type="switch"
                        label="Calibrar (Conformal)"
                        checked={calibrate}
                        onChange={(e) => setCalibrate(e.currentTarget.checked)}
                      />
                      <Form.Check
                        type="switch"
                        label="Micro-Model"
                        checked={useMicroModel}
                        onChange={(e) =>
                          setUseMicroModel(e.currentTarget.checked)
                        }
                      />
                    </div>
                  </Col>
                </Row>
              </Card.Body>
            </Card>
          </Col>
        </Row>
      </Container>
    </div>
  );
}
