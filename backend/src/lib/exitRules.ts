/* exitRules.ts — regras de saída pré-confirmação (fail-fast)
   NÃO altera nomes de pastas/arquivos existentes.
   Uso: importar funções puras e aplicar no pipeline de geração de sinais/execução.
*/
export type Side = "BUY" | "SELL";

export type PreConfParams = {
    timeoutBars?: number;           // K: nº de candles para aguardar confirmação
    alphaPre?: number;              // multiplicador ATR para SL pré-confirmação
    invalidateBy?: "EMA21" | "VWAP" | "NONE"; // linha de invalidação estrutural
};

export type PreConfInputs = {
    side: Side;
    entryIdx: number;               // índice do candle de ENTRADA (j = i+1)
    entryPrice: number;
    tfMin: number;                  // timeframe em minutos (ex.: 5)
    times: Date[];                  // vetor completo de times (candles)
    atr: Array<number | null>;      // ATR na barra i (usar i do cross para pré-cálculo)
    ema21: Array<number | null>;    // EMA21 por barra (para invalidação)
    vwap: Array<number | null>;     // VWAP por barra (para invalidação)
    iCross: number;                 // índice da barra que gerou o sinal (cross)
};

export type PreConfResult = {
    timeoutBars: number;
    expiresAt: string | null;       // ISO
    preStopPrice: number | null;    // SL pré-confirmação (tighter)
    invalidateBy: "EMA21" | "VWAP" | "NONE";
    invalidateLine: number | null;  // preço da linha (EMA21/VWAP) na barra do cross
    rulesText: string;              // resumo textual
};

function clamp(n: number, a: number, b: number) {
    return Math.min(b, Math.max(a, n));
}

export function defaultParamsForTf(tfMin: number): Required<PreConfParams> {
    // heurísticas iniciais
    if (tfMin <= 1) {
        return { timeoutBars: 5, alphaPre: 0.7, invalidateBy: "EMA21" };
    }
    if (tfMin <= 5) {
        return { timeoutBars: 3, alphaPre: 0.9, invalidateBy: "EMA21" };
    }
    return { timeoutBars: 2, alphaPre: 1.0, invalidateBy: "EMA21" };
}

export function computePreConfirmationPackage(
    inputs: PreConfInputs,
    params?: PreConfParams
): PreConfResult {
    const {
        side,
        entryIdx,
        entryPrice,
        tfMin,
        times,
        atr,
        ema21,
        vwap,
        iCross,
    } = inputs;

    const p = {
        ...defaultParamsForTf(tfMin),
        ...(params || {}),
    };

    // Timeout → fecha no fechamento do K-ésimo candle após a entrada
    let expiresAt: string | null = null;
    const k = clamp(Math.floor(p.timeoutBars), 0, 1000);
    if (k > 0 && Number.isFinite(entryIdx)) {
        const idx = Math.min(entryIdx + (k - 1), times.length - 1);
        const dt = times[idx];
        if (dt instanceof Date && !isNaN(dt.getTime())) {
            expiresAt = dt.toISOString();
        }
    }

    // SL pré-confirmação (atr do cross i)
    const atrv = iCross >= 0 && atr[iCross] != null ? Number(atr[iCross]) : 0;
    const pts = Math.max(0, Number(p.alphaPre) * (atrv || 0));
    const preStopPrice =
        pts > 0
            ? side === "BUY"
                ? entryPrice - pts
                : entryPrice + pts
            : null;

    // Linha de invalidação estrutural
    let invalidateLine: number | null = null;
    if (p.invalidateBy === "EMA21") {
        const v = iCross >= 0 && ema21[iCross] != null ? Number(ema21[iCross]) : null;
        invalidateLine = v == null || !isFinite(v) ? null : v;
    } else if (p.invalidateBy === "VWAP") {
        const v = iCross >= 0 && vwap[iCross] != null ? Number(vwap[iCross]) : null;
        invalidateLine = v == null || !isFinite(v) ? null : v;
    } else {
        invalidateLine = null;
    }

    const rulesText = [
        k > 0 ? `timeout ${k} bar(s)` : null,
        preStopPrice != null ? `preSL α=${Number(p.alphaPre).toFixed(2)}·ATR` : null,
        p.invalidateBy !== "NONE" ? `invalidate by ${p.invalidateBy}` : null,
    ]
        .filter(Boolean)
        .join(" | ");

    return {
        timeoutBars: k,
        expiresAt,
        preStopPrice,
        invalidateBy: p.invalidateBy,
        invalidateLine,
        rulesText,
    };
}
