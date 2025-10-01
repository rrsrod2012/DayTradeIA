import { Router, Request, Response } from 'express';
import { eventBus } from '../../core/eventBus';
import { logger } from '../../core/logger';

const router = Router();

router.post('/notify', (req: Request, res: Response) => {
    try {
        const { event, symbol, side, volume, price, pnlPoints } = req.body;
        logger.info(`[Notify Route] Recebido evento de notificação:`, req.body);

        let message: string | null = null;

        if (event === 'opened') {
            message = `📲 *MT5* — *Ordem ABERTA*\n• Símbolo: ${symbol}\n• Lado: ${side} • Vol: ${volume}\n• Preço: ${price}`;
        } else if (event === 'closed') {
            const pnl = parseFloat(pnlPoints ?? 0);
            const emoji = pnl >= 0 ? "✅" : "❌";
            message = `📲 *MT5* — *Ordem FECHADA* ${emoji}\n• Símbolo: ${symbol}\n• Resultado: ${pnl} ponto(s)`;
        }

        if (message) {
            // Emite um evento para o serviço de notificação lidar com o envio
            eventBus.emit('notification:send', message);
        }

        res.status(200).json({ ok: true });
    } catch (error: any) {
        logger.error('[Notify Route] Erro ao processar notificação', { error: error?.message });
        res.status(500).json({ ok: false, error: 'Erro interno no servidor' });
    }
});

export const notifyRoutes = router;