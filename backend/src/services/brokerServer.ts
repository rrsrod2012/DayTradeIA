/* backend/src/brokerServer.ts
   Servidor HTTP para eventos MT5 + leitura de trades reais (persistência via Prisma RAW).
   Rodar: npx tsx src/brokerServer.ts   (BROKER_PORT=4002 opcional)
*/
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import { ensureTables, recordOrderNew, recordOrderModify, recordOrderClose, listTrades, summary } from "./services/brokerPersist";

const app = express();
const PORT = Number(process.env.BROKER_PORT || 4002);

app.use(cors());
app.use(bodyParser.json({ limit: "1mb" }));

app.get("/healthz", (_req, res) => res.json({ ok: true }));

app.post("/api/broker/event", async (req, res) => {
    try {
        const ev = req.body;
        if (!ev || !ev.type) return res.status(400).json({ ok: false, error: "Missing event.type" });

        if (ev.type === "ORDER_NEW") {
            await recordOrderNew({
                idMt5: String(ev.idMt5),
                symbol: String(ev.symbol || ""),
                side: String(ev.side || "BUY").toUpperCase() === "SELL" ? "SELL" : "BUY",
                volume: Number(ev.volume || 0),
                entryPrice: Number(ev.entryPrice || 0),
                entryTime: String(ev.entryTime || new Date().toISOString()),
                sl: ev.sl != null ? Number(ev.sl) : null,
                tp: ev.tp != null ? Number(ev.tp) : null,
            });
            return res.json({ ok: true });
        }

        if (ev.type === "ORDER_MODIFY") {
            await recordOrderModify({
                idMt5: String(ev.idMt5),
                sl: ev.sl != null ? Number(ev.sl) : null,
                tp: ev.tp != null ? Number(ev.tp) : null,
                time: ev.time ? String(ev.time) : null,
            });
            return res.json({ ok: true });
        }

        if (ev.type === "ORDER_CLOSE") {
            await recordOrderClose({
                idMt5: String(ev.idMt5),
                exitPrice: Number(ev.exitPrice || 0),
                exitTime: String(ev.exitTime || new Date().toISOString()),
                exitReason: String(ev.exitReason || "UNKNOWN"),
                commission: ev.commission != null ? Number(ev.commission) : null,
                swap: ev.swap != null ? Number(ev.swap) : null,
                slippagePts: ev.slippagePts != null ? Number(ev.slippagePts) : null,
            });
            return res.json({ ok: true });
        }

        return res.status(400).json({ ok: false, error: `Unknown event.type: ${ev.type}` });
    } catch (e: any) {
        return res.status(200).json({ ok: false, error: e?.message || String(e) });
    }
});

app.get("/api/broker/trades", async (req, res) => {
    try {
        const symbol = req.query.symbol ? String(req.query.symbol).toUpperCase() : undefined;
        const from = req.query.from ? String(req.query.from) : undefined;
        const to = req.query.to ? String(req.query.to) : undefined;
        const limit = req.query.limit ? Number(req.query.limit) : undefined;
        const rows = await listTrades({ symbol, from, to, limit });
        return res.json(rows);
    } catch (e: any) {
        return res.status(200).json({ ok: false, error: e?.message || String(e) });
    }
});

app.get("/api/broker/summary", async (req, res) => {
    try {
        const symbol = req.query.symbol ? String(req.query.symbol).toUpperCase() : undefined;
        const from = req.query.from ? String(req.query.from) : undefined;
        const to = req.query.to ? String(req.query.to) : undefined;
        const payload = await summary({ symbol, from, to });
        return res.json({ ok: true, ...payload });
    } catch (e: any) {
        return res.status(200).json({ ok: false, error: e?.message || String(e) });
    }
});

ensureTables().then(() => {
    app.listen(PORT, () => {
        console.log(`[brokerServer] http://127.0.0.1:${PORT}`);
    });
});
