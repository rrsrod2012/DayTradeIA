import { eventBus, EVENTS } from '../../core/eventBus';
import { logger } from '../../core/logger';

// Esta é uma implementação "mock" do seu serviço de WhatsApp.
// Você precisará integrar sua biblioteca real aqui (ex: venom-bot, whatsapp-web.js)
const sendWhatsAppText = async (message: string) => {
  logger.info(`[WhatsApp] Enviando mensagem: ${message}`);
  // LÓGICA DE ENVIO REAL AQUI
  return Promise.resolve();
};

const handleTradeExecution = async (payload: any) => {
    const { event, symbol, side, volume, price, pnlPoints } = payload;

    if (event === 'opened') {
        const msg = `📲 *MT5* — *Ordem ABERTA*\n• Símbolo: ${symbol}\n• Lado: ${side} • Vol: ${volume}\n• Preço: ${price}`;
        await sendWhatsAppText(msg);
    } else if (event === 'closed') {
        const emoji = pnlPoints >= 0 ? "✅" : "❌";
        const msg = `📲 *MT5* — *Ordem FECHADA* ${emoji}\n• Símbolo: ${symbol}\n• Resultado: ${pnlPoints} ponto(s)`;
        await sendWhatsAppText(msg);
    }
};

export const initNotificationService = () => {
  // Escuta por eventos de trade executado para enviar notificações
  eventBus.on(EVENTS.TRADE_EXECUTED, handleTradeExecution);

  // Escuta por requisições da rota /notify original
  // Adicione a rota /notify no seu api.ts e faça ela emitir este evento
  eventBus.on('notify:trade', handleTradeExecution)

  logger.info('✅ Serviço de Notificações inicializado.');
};