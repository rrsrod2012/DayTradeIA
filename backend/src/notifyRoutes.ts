import { Router } from "express";
import { sendWhatsAppText } from "./services/whatsapp";
import logger from "./logger"; // <-- CORRIGIDO de '../logger' para './logger'

export const notifyRoutes = Router();

/**
 * Middleware para logar detalhes da requisição recebida.
 * Isso nos ajudará a identificar a origem das chamadas.
 */
notifyRoutes.use((req, _res, next) => {
    const ip = req.ip || req.connection.remoteAddress;
    const forwarded = req.headers['x-forwarded-for'];
    const userAgent = req.headers['user-agent'];

    // Log detalhado para diagnóstico
    logger.info("[NOTIFY_TRACE] Recebida requisição em /notify", {
        path: req.path,
        method: req.method,
        ip,
        forwarded,
        userAgent,
        headers: req.headers, // Loga todos os cabeçalhos
        body: req.body,
    });

    next();
});


/**
 * Recebe eventos do EA:
 * opened: { symbol, side, volume, entryPrice, positionId, ticket }
 * closed: { symbol, side, volume, exitPrice, positionId, ticket, pnlPoints }
 */
notifyRoutes.post("/trade", async (req, res) => {
    try {
        const ev = (req.body?.event || "").toString();
        if (ev !== "opened" && ev !== "closed") {
            return res.status(400).json({ ok: false, error: "invalid_event" });
        }
        const sym = (req.body?.symbol || "").toString();
        const side = (req.body?.side || "").toString().toUpperCase(); // BUY/SELL
        const vol = Number(req.body?.volume || 0);
        const posId = (req.body?.positionId || "").toString();
        const ticket = (req.body?.ticket || "").toString();

        if (ev === "opened") {
            const entry = Number(req.body?.entryPrice || 0);
            const msg = [
                "📲 *MT5* — *Ordem ABERTA*",
                `• Símbolo: ${sym}`,
                `• Lado: ${side}  • Vol: ${vol}`,
                `• Preço de entrada: ${entry}`,
                posId ? `• Posição: ${posId}` : "",
                ticket ? `• Ticket: ${ticket}` : "",
                `⏱️ ${new Date().toLocaleString()}`
            ].filter(Boolean).join("\n");
            await sendWhatsAppText(msg);
        } else {
            const exit = Number(req.body?.exitPrice || 0);
            const pts = Number(req.body?.pnlPoints || 0);
            const emoji = pts >= 0 ? "✅" : "❌";
            const msg = [
                `📲 *MT5* — *Ordem FECHADA* ${emoji}`,
                `• Símbolo: ${sym}`,
                `• Lado: ${side}  • Vol: ${vol}`,
                `• Preço de saída: ${exit}`,
                `• Resultado: ${pts} ponto(s)`,
                posId ? `• Posição: ${posId}` : "",
                ticket ? `• Ticket: ${ticket}` : "",
                `⏱️ ${new Date().toLocaleString()}`
            ].filter(Boolean).join("\n");
            await sendWhatsAppText(msg);
        }

        res.json({ ok: true });
    } catch (err: any) {
        console.error("[/notify/trade] error:", err);
        res.status(500).json({ ok: false, error: "internal_error" });
    }
});