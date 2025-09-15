/* eslint-disable no-console */
import express from "express";
import { DateTime } from "luxon";
import { loadCandlesAnyTF } from "../lib/aggregation";
import { computePreConfirmationPackage } from "../lib/exitRules";

export const router = express.Router();

const ZONE = "America/Sao_Paulo";
const VERSION = "signals-projected:v1.2-antiwhipsaw";

/** ------- Helpers ------- */
function normalizeTf(tfRaw: string): { tfU: string; tfMin: number } {
  const s = String(tfRaw || "")
    .trim()
    .toUpperCase();
  if (!s) return { tfU: "M5", tfMin: 5 };
  if (s === "M1") return { tfU: "M1", tfMin: 1 };
  if (s === "M5") return { tfU: "M5", tfMin: 5 };
  if (s === "M15") return { tfU: "M15", tfMin: 15 };
  if (s === "M30") return { tfU: "M30", tfMin: 30 };
  if (s === "H1") return { tfU: "H1", tfMin: 60 };
  if (/^M(\d+)$/.test(s)) return { tfU: s, tfMin: Number(s.slice(1)) || 5 };
  if (/^H(\d+)$/.test(s)) return { tfU: s, tfMin: (Number(s.slice(1)) || 1) * 60 };
  return { tfU: "M5", tfMin: 5 };
}

function parseUserDate(s: any): { ok: boolean; dt: DateTime } {
  if (!s) return { ok: false, dt: DateTime.invalid("empty") };
  if (typeof s === "string") {
    const direct = DateTime.fromISO(s, { zone: "utc" });
    if (direct.isValid) return { ok: true, dt: direct };
    const m = s.match(
      /^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2})(?::(\d{2})(?::(\d{2}))?)?)?$/
    );
    if (m) {
      const [, dd, mm, yyyy, H = "00", M = "00", S = "00"] = m;
      const z = DateTime.fromISO(`${yyyy}-${mm}-${dd}T${H}:${M}:${S}Z`, {
        zone: "utc",
      });
      return { ok: z.isValid, dt: z };
    }
  }
  const d = new Date(s);
  if (!isNaN(d.getTime())) return { ok: true, dt: DateTime.fromJSDate(d).toUTC() };
  return { ok: false, dt: DateTime.invalid("unparsed") };
}

function floorTo(d: Date, tfMin: number): Date {
  const dt = DateTime.fromJSDate(d).toUTC();
  const bucketMin = Math.floor(dt.minute / tfMin) * tfMin;
  return dt.set({ second: 0, millisecond: 0, minute: bucketMin }).toJSDate();
}
function ceilToExclusive(d: Date, tfMin: number): Date {
  const dt = DateTime.fromJSDate(d).toUTC();
  const bucketMin = Math.floor(dt.minute / tfMin) * tfMin + tfMin;
  return dt.set({ second: 0, millisecond: 0, minute: bucketMin }).toJSDate();
}

/* -------- Indicadores -------- */
function EMA(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = [];
  const k = 2 / (period + 1);
  let ema: number | null = null;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!isFinite(v)) {
      out.push(ema);
      continue;
    }
    ema = ema == null ? v : v * k + ema * (1 - k);
    out.push(ema);
  }
  return out;
}

function ATR(
  candles: { high: number; low: number; close: number }[],
  period = 14
): (number | null)[] {
  const tr: number[] = [];
  for (let i = 0; i < candles.length; i++) {
    const prev = i > 0 ? candles[i - 1].close : candles[i].close;
    const high = candles[i].high;
    const low = candles[i].low;
    const v = Math.max(
      high - low,
      Math.abs(high - prev),
      Math.abs(low - prev)
    );
    tr.push(v);
  }
  // RMA simples para aproximar ATR
  const out: (number | null)[] = [];
  const k = 1 / Math.max(1, period);
  let rma: number | null = null;
  for (let i = 0; i < tr.length; i++) {
    const v = tr[i];
    rma = rma == null ? v : rma * (1 - k) + v * k;
    out.push(rma);
  }
  return out;
}

/** ADX “clássico” simplificado (Wilder). Retorna array com ADX. */
function ADX(
  candles: { high: number; low: number; close: number }[],
  period = 14
): (number | null)[] {
  const len = candles.length;
  const plusDM: number[] = [];
  const minusDM: number[] = [];
  const tr: number[] = [];

  for (let i = 0; i < len; i++) {
    if (i === 0) {
      plusDM.push(0);
      minusDM.push(0);
      tr.push(candles[0].high - candles[0].low);
      continue;
    }
    const upMove = candles[i].high - candles[i - 1].high;
    const downMove = candles[i - 1].low - candles[i].low;
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);

    const _tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close)
    );
    tr.push(_tr);
  }

  // RMA de TR, +DM, -DM
  const rma = (arr: number[]): number[] => {
    const out: number[] = [];
    const k = 1 / period;
    let v: number | null = null;
    for (let i = 0; i < arr.length; i++) {
      v = v == null ? arr[i] : v * (1 - k) + arr[i] * k;
      out.push(v);
    }
    return out as number[];
  };

  const trRMA = rma(tr);
  const plusDMRMA = rma(plusDM);
  const minusDMRMA = rma(minusDM);

  const plusDI: number[] = [];
  const minusDI: number[] = [];
  const dx: (number | null)[] = [];
  for (let i = 0; i < len; i++) {
    const trv = trRMA[i] || 0;
    const pdi = trv > 0 ? (plusDMRMA[i] / trv) * 100 : 0;
    const mdi = trv > 0 ? (minusDMRMA[i] / trv) * 100 : 0;
    plusDI.push(pdi);
    minusDI.push(mdi);
    const denom = pdi + mdi;
    dx.push(denom > 0 ? (Math.abs(pdi - mdi) / denom) * 100 : null);
  }

  // ADX = RMA do DX
  const adx: (number | null)[] = [];
  const k = 1 / period;
  let val: number | null = null;
  for (let i = 0; i < len; i++) {
    const dxi = dx[i];
    if (dxi == null) {
      adx.push(val);
      continue;
    }
    val = val == null ? dxi : val * (1 - k) + dxi * k;
    adx.push(val);
  }
  return adx;
}

/** ------- Types ------- */
type Row = {
  side: "BUY" | "SELL";
  suggestedEntry: number | null;
  stopSuggestion: number | null;
  takeProfitSuggestion: number | null;

  // Pré-confirmação (fail-fast) — já entregue antes
  preConfTimeoutBars?: number;
  preConfExpiresAt?: string | null;
  preConfStop?: number | null;
  preConfInvalidateBy?: "EMA21" | "VWAP" | "NONE";
  preConfInvalidateLine?: number | null;
  preConfText?: string;

  // Diagnóstico Anti-Whipsaw (novo; opcional)
  filters?: {
    adx?: number | null;
    spread?: number | null;       // EMA9-EMA21 (pts)
    slope?: number | null;        // Δspread (pts)
    vwapDist?: number | null;     // |preço - vwap| (pts)
    passed: boolean;
    reasons: string[];            // por que passou/falhou
  };

  conditionText: string;
  probHit?: number | null;
  probCalibrated?: number | null;
  expectedValuePoints?: number | null;
  time: string; // ISO
  date: string; // BRT formatado
};

/** ------- Router ------- */
router.post("/api/signals/projected", express.json(), async (req, res) => {
  try {
    const body = (req.body || {}) as Record<string, any>;

    // Parâmetros já existentes
    const {
      symbol,
      timeframe,
      from,
      to,
      rr = 2,
      minProb = 0,
      minEV = -Infinity,
      costPts = 0,
      slippagePts = 0,
      atrPeriod = 14,
      k_sl = 1.0,
      k_tp = rr,
      vwapFilter = false,
      requireMtf = false,
      confirmTf = "M15",
      useMicroModel = true, // placeholder
    } = body;

    // Pré-confirmação (fail-fast) — já implementado
    const {
      preConfTimeoutBars = undefined,
      preConfAlpha = undefined,
      preConfInvalidateBy = undefined, // "EMA21" | "VWAP" | "NONE"
    } = body;

    // ---------- Anti-Whipsaw (NOVOS parâmetros — todos opcionais) ----------
    const {
      adxMin,                 // mínimo de ADX para aceitar cruzamento (ex.: 18)
      spreadMinAtr,           // |EMA9-EMA21| >= spreadMinAtr * ATR (ex.: 0.25)
      slopeMinAtr,            // |Δspread|    >= slopeMinAtr  * ATR (ex.: 0.05)
      vwapSideRequired,       // exige preço do lado “correto” da VWAP
      vwapMinDistAtr,         // distância mínima à VWAP em ATRs (ex.: 0.10)
      cooldownBars,           // nº mínimo de barras entre sinais aceitos (ex.: 2-3)
    } = body;

    const sym = String(symbol || "")
      .trim()
      .toUpperCase();
    if (!sym)
      return res.status(200).json({ ok: false, version: VERSION, error: "Faltou 'symbol'" });

    const { tfU, tfMin } = normalizeTf(String(timeframe || "M5"));

    // Range
    const pFrom = parseUserDate(from);
    const pTo = parseUserDate(to);
    const nowLocal = DateTime.now().setZone(ZONE);
    const fromD = pFrom.ok
      ? floorTo(pFrom.dt.toJSDate(), tfMin)
      : nowLocal.startOf("day").toUTC().toJSDate();
    const toD = pTo.ok
      ? ceilToExclusive(pTo.dt.toJSDate(), tfMin)
      : nowLocal.endOf("day").toUTC().toJSDate();

    if (fromD >= toD) {
      return res.status(200).json({
        ok: false,
        version: VERSION,
        error: "'from' deve ser anterior a 'to'",
      });
    }

    // Candles
    const candles = await loadCandlesAnyTF(sym, tfU, { gte: fromD, lte: toD });
    if (!candles?.length) return res.status(200).json({ ok: true, version: VERSION, data: [] });

    const closes = candles.map((c) => Number(c.close));
    const highs = candles.map((c) => Number(c.high));
    const lows = candles.map((c) => Number(c.low));
    const opens = candles.map((c) => Number(c.open));
    const times = candles.map((c) => c.time);

    const e9 = EMA(closes, 9);
    const e21 = EMA(closes, 21);
    const atr = ATR(
      candles.map((c) => ({ high: c.high, low: c.low, close: c.close })),
      Number(atrPeriod) || 14
    );
    const adx = ADX(
      candles.map((c) => ({ high: c.high, low: c.low, close: c.close })),
      14
    );

    // VWAP por sessão (BRT)
    const vwap: (number | null)[] = [];
    let accPV = 0,
      accVol = 0;
    let prevDay: string | null = null;
    for (let i = 0; i < candles.length; i++) {
      const day = DateTime.fromJSDate(times[i]).setZone(ZONE).toFormat("yyyy-LL-dd");
      if (day !== prevDay) {
        prevDay = day;
        accPV = 0;
        accVol = 0;
      }
      const typical = (highs[i] + lows[i] + closes[i]) / 3;
      const vol = Number.isFinite((candles[i] as any).volume)
        ? Number((candles[i] as any).volume)
        : 1;
      accPV += typical * vol;
      accVol += vol;
      vwap.push(accVol > 0 ? accPV / accVol : typical);
    }

    // -------- micro-model (placeholder) --------
    async function getProb(_features: Record<string, number>): Promise<number | null> {
      return null;
    }

    const out: Row[] = [];

    // Controle de cooldown entre sinais aceitos
    let lastAcceptedIndex = -1;
    const minGap = Number.isFinite(cooldownBars) ? Math.max(0, Number(cooldownBars)) : 0;

    for (let i = 1; i < candles.length - 1; i++) {
      // “cross persistente” (evita flip de 1 tick)
      const prevUp = e9[i - 1] != null && e21[i - 1] != null && (e9[i - 1] as number) <= (e21[i - 1] as number);
      const nowUp = e9[i] != null && e21[i] != null && (e9[i] as number) > (e21[i] as number);
      const prevDn = e9[i - 1] != null && e21[i - 1] != null && (e9[i - 1] as number) >= (e21[i - 1] as number);
      const nowDn = e9[i] != null && e21[i] != null && (e9[i] as number) < (e21[i] as number);

      const crossUp = prevUp && nowUp;
      const crossDn = prevDn && nowDn;
      if (!crossUp && !crossDn) continue;

      // Cooldown entre sinais aceitos (anti-reversão imediata)
      if (minGap > 0 && lastAcceptedIndex >= 0 && i - lastAcceptedIndex < minGap) {
        continue;
      }

      const j = Math.min(i + 1, candles.length - 1); // entrada na abertura da próxima barra
      const entry = Number.isFinite(opens[j]) ? opens[j] : closes[j];

      // SL/TP baseados em ATR e RR
      const atrv = atr[i] ?? 0;
      const slPts = Math.max(atrv * Number(k_sl), 0);
      const tpPts = Math.max(atrv * Number(k_tp), 0);

      const isBuy = !!crossUp;
      const sl = slPts > 0 ? (isBuy ? entry - slPts : entry + slPts) : null;
      const tp = tpPts > 0 ? (isBuy ? entry + tpPts : entry - tpPts) : null;

      /* ---------- Anti-Whipsaw: filtros de aceitação ---------- */
      const reasons: string[] = [];
      let passed = true;

      // ADX
      const adxMinEff =
        Number.isFinite(adxMin)
          ? Number(adxMin)
          : (tfMin <= 1 ? 16 : 18); // defaults: M1=16, M5=18
      const adxVal = adx[i] ?? null;
      if (adxVal == null || adxVal < adxMinEff) {
        passed = false;
        reasons.push(`ADX(${adxVal?.toFixed(1) ?? "-"})<${adxMinEff}`);
      } else {
        reasons.push(`ADX=${adxVal.toFixed(1)}`);
      }

      // spread e slope (em pontos)
      const sNow = (e9[i] ?? entry) - (e21[i] ?? entry);
      const sPrev = (e9[i - 1] ?? entry) - (e21[i - 1] ?? entry);
      const slope = sNow - sPrev;
      const spreadAbs = Math.abs(sNow);
      const atrRef = Math.max(atrv, 1e-6);

      const spreadMinEff = Number.isFinite(spreadMinAtr) ? Math.max(0, Number(spreadMinAtr)) : (tfMin <= 1 ? 0.20 : 0.25);
      const slopeMinEff = Number.isFinite(slopeMinAtr) ? Math.max(0, Number(slopeMinAtr)) : (tfMin <= 1 ? 0.05 : 0.06);

      if (spreadAbs < spreadMinEff * atrRef) {
        passed = false;
        reasons.push(`spread(${spreadAbs.toFixed(1)})<${(spreadMinEff * atrRef).toFixed(1)}`);
      } else {
        reasons.push(`spread=${spreadAbs.toFixed(1)}`);
      }

      if (Math.abs(slope) < slopeMinEff * atrRef) {
        passed = false;
        reasons.push(`slope(${Math.abs(slope).toFixed(1)})<${(slopeMinEff * atrRef).toFixed(1)}`);
      } else {
        reasons.push(`slope=${slope.toFixed(1)}`);
      }

      // VWAP (lado e distância)
      const v = vwap[i] ?? null;
      if (v != null) {
        const dist = Math.abs(entry - v);
        const vwapMinDistEff = Number.isFinite(vwapMinDistAtr) ? Math.max(0, Number(vwapMinDistAtr)) : 0; // default 0 = sem exigir dist
        const needSide = !!vwapSideRequired || !!vwapFilter; // se já usa vwapFilter, exija lado correto por padrão

        if (needSide) {
          const okSide = isBuy ? entry >= v : entry <= v;
          if (!okSide) {
            passed = false;
            reasons.push(`VWAP.side(${isBuy ? "entry<vwap" : "entry>vwap"})`);
          } else {
            reasons.push("VWAP.side=ok");
          }
        }

        if (vwapMinDistEff > 0 && dist < vwapMinDistEff * atrRef) {
          passed = false;
          reasons.push(`VWAP.dist(${dist.toFixed(1)})<${(vwapMinDistEff * atrRef).toFixed(1)}`);
        } else if (vwapMinDistEff > 0) {
          reasons.push(`VWAP.dist=${dist.toFixed(1)}`);
        }
      }

      if (!passed) {
        // Reprovado nos filtros anti-whipsaw: não gera sinal
        continue;
      }

      /* ---------- Prob/EV (heurístico se micro-model indisponível) ---------- */
      async function getProb(_features: Record<string, number>): Promise<number | null> {
        return null;
      }
      let prob = await getProb({});
      if (prob == null) {
        const raw = 0.5 + Math.max(-0.08, Math.min(0.08, (sNow / atrRef) * 0.1));
        prob = Math.max(0.35, Math.min(0.70, raw));
      }
      const costs = Math.max(0, Number(costPts) || 0) + Math.max(0, Number(slippagePts) || 0);
      const evPts = prob * (tpPts || 0) - (1 - prob) * (slPts || 0) - costs;

      if (prob < Number(minProb)) continue;
      if (evPts < Number(minEV)) continue;

      // Pacote pré-confirmação (fail-fast)
      const preConf = computePreConfirmationPackage(
        {
          side: isBuy ? "BUY" : "SELL",
          entryIdx: j,
          entryPrice: entry,
          tfMin,
          times,
          atr,
          ema21: e21.map((v2) => (v2 == null ? null : Number(v2))),
          vwap: vwap.map((v2) => (v2 == null ? null : Number(v2))),
          iCross: i,
        },
        {
          timeoutBars: preConfTimeoutBars,
          alphaPre: preConfAlpha,
          invalidateBy: preConfInvalidateBy,
        }
      );

      out.push({
        side: isBuy ? "BUY" : "SELL",
        suggestedEntry: entry,
        stopSuggestion: sl,
        takeProfitSuggestion: tp,

        preConfTimeoutBars: preConf.timeoutBars,
        preConfExpiresAt: preConf.expiresAt,
        preConfStop: preConf.preStopPrice,
        preConfInvalidateBy: preConf.invalidateBy,
        preConfInvalidateLine: preConf.invalidateLine,
        preConfText: preConf.rulesText,

        filters: {
          adx: adxVal == null ? null : Number(adxVal.toFixed(1)),
          spread: Number(spreadAbs.toFixed(1)),
          slope: Number(slope.toFixed(1)),
          vwapDist:
            vwap[i] == null ? null : Number(Math.abs(entry - (vwap[i] as number)).toFixed(1)),
          passed: true,
          reasons,
        },

        conditionText: `EMA9 vs EMA21 ${isBuy ? "UP" : "DOWN"}${vwapFilter ? " + VWAP" : ""
          }${requireMtf ? ` + MTF(${confirmTf})` : ""}`,
        probHit: Number(prob.toFixed(4)),
        probCalibrated: Number(prob.toFixed(4)),
        expectedValuePoints: Number(evPts.toFixed(2)),
        time: times[j].toISOString(),
        date: DateTime.fromJSDate(times[j]).setZone(ZONE).toFormat("yyyy-LL-dd HH:mm:ss"),
      });

      lastAcceptedIndex = i; // dispara cooldown
    }

    return res.status(200).json({ ok: true, version: VERSION, data: out });
  } catch (e: any) {
    console.error("[/api/signals/projected] erro inesperado:", e?.stack || e?.message || e);
    return res.status(200).json({
      ok: false,
      version: VERSION,
      error: "unexpected",
      diag: String(e?.stack || e?.message || e),
    });
  }
});

export default router;
