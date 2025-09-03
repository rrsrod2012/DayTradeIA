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
};

const LS_KEY = "dtia.settings.v3"; // bump para incluir filtros de horário

function weekBusinessRange() {
  const d = new Date();
  const day = d.getDay(); // 0..6
  const diffToMon = (day + 6) % 7;
  const monday = new Date(d);
  monday.setDate(d.getDate() - diffToMon);
  const friday = new Date(monday);
  friday.setDate(monday.getDate() + 4);
  const fmt = (x: Date) =>
    `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(
      x.getDate()
    ).padStart(2, "0")}`;
  return { from: fmt(monday), to: fmt(friday) };
}

export default function Dashboard() {
  const [symbol, setSymbol] = useState("WIN");
  const [timeframe, setTimeframe] = useState("M5");
  const [dateFrom, setDateFrom] = useState<string>("");
  const [dateTo, setDateTo] = useState<string>("");
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
      if (raw) {
        const s = JSON.parse(raw);
        if (s.symbol) setSymbol(s.symbol);
        if (s.timeframe) setTimeframe(s.timeframe);
        if (s.dateFrom) setDateFrom(s.dateFrom);
        if (s.dateTo) setDateTo(s.dateTo);
        if (typeof s.showFibo === "boolean") setShowFibo(s.showFibo);
        if (typeof s.darkMode === "boolean") setDarkMode(s.darkMode);

        if (typeof s.horizon === "number") setHorizon(s.horizon);
        if (typeof s.rr === "number") setRR(s.rr);
        if (typeof s.evalWindow === "number") setEvalWindow(s.evalWindow);
        if (typeof s.gateRegime === "boolean") setGateRegime(s.gateRegime);
        if (typeof s.gateToD === "boolean") setGateToD(s.gateToD);
        if (typeof s.calibrate === "boolean") setCalibrate(s.calibrate);
        if (typeof s.useMicroModel === "boolean")
          setUseMicroModel(s.useMicroModel);
        if (typeof s.minProb === "number") setMinProb(s.minProb);
        if (typeof s.minEV === "number") setMinEV(s.minEV);
        if (typeof s.dailyLossCap === "number") setDailyLossCap(s.dailyLossCap);

        if (typeof s.applyHourFilter === "boolean")
          setApplyHourFilter(s.applyHourFilter);
        if (typeof s.hourStart === "number") setHourStart(s.hourStart);
        if (typeof s.hourEnd === "number") setHourEnd(s.hourEnd);
      } else {
        // valores padrão de data: semana útil
        const r = weekBusinessRange();
        setDateFrom(r.from);
        setDateTo(r.to);
      }
    } catch {
      const r = weekBusinessRange();
      setDateFrom(r.from);
      setDateTo(r.to);
    }
  }, []);

  // Salva no localStorage quando qualquer parâmetro/filtro muda
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
    };
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(payload));
    } catch {}
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
  ]);

  // Tema
  useEffect(() => {
    document.body.classList.toggle("theme-dark", darkMode);
    return () => document.body.classList.remove("theme-dark");
  }, [darkMode]);

  const params = useMemo(
    () => ({
      symbol: symbol.toUpperCase(),
      timeframe: timeframe.toUpperCase(),
      from: dateFrom || undefined,
      to: dateTo || undefined,
    }),
    [symbol, timeframe, dateFrom, dateTo]
  );

  const loadAll = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      const cc = await api.get("/candles", { params });
      setCandles(cc.data ?? []);

      const ss = await api.get("/signals", { params });
      setSignals(Array.isArray(ss.data?.signals) ? ss.data.signals : []);

      const pp = await api.get("/signals/projected", {
        params: {
          ...params,
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
        },
      });
      setProjected(pp.data?.projected ?? []);

      const bt = await api.post("/backtest", {
        symbol,
        timeframe,
        from: dateFrom || undefined,
        to: dateTo || undefined,
        lossCap: Number(dailyLossCap) || 0,
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
    dateFrom,
    dateTo,
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
    params,
  ]);

  useEffect(() => {
    if (dateFrom && dateTo) loadAll();
  }, [loadAll, dateFrom, dateTo]);

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
        // faixa cruzando meia-noite (ex.: 22->2)
        return h >= start || h <= end;
      };
      return trades.filter((t) => {
        const d = t?.entryTime ? new Date(t.entryTime) : null;
        const hr = d ? d.getHours() : null;
        if (hr === null) return false; // sem hora, não entra no filtro
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
        prob: p.probCalibrated ?? p.probHit,
        ev_points: p.expectedValuePoints,
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
              <Col sm={5} className="text-end">
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
                    onChange={() => {}}
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
