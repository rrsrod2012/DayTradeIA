import fetch from 'node-fetch';
import { eventBus, EVENTS } from '../../core/eventBus';
import { logger } from '../../core/logger';

const WA_TOKEN = process.env.WHATSAPP_TOKEN || "";
const WA_PHONEID = process.env.WHATSAPP_PHONE_ID || "";
const WA_TO_LIST = (process.env.WHATSAPP_TO || "").split(",").map(s => s.trim()).filter(Boolean);

const sendWhatsAppText = async (text: string) => {
    if (!WA_TOKEN || !WA_PHONEID || WA_TO_LIST.length === 0) {
        logger.warn("[WhatsApp] Credenciais/números ausentes. Mensagem não enviada.", { hasToken: !!WA_TOKEN, hasPhoneId: !!WA_PHONEID, toCount: WA_TO_LIST.length });
        return;
    }
    const url = `https://graph.facebook.com/v19.0/${WA_PHONEID}/messages`;

    logger.info(`[WhatsApp] Enviando mensagem para ${WA_TO_LIST.length} número(s)...`);

    for (const to of WA_TO_LIST) {
        try {
            const res = await fetch(url, {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${WA_TOKEN}`,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    messaging_product: "whatsapp",
                    to,
                    type: "text",
                    text: { body: text }
                }),
            });
            const body = await res.json().catch(() => ({}));
            if (!res.ok) {
                logger.error(`[WhatsApp] Falha ao enviar para ${to}`, { status: res.status, body });
            } else {
                logger.info(`[WhatsApp] Mensagem enviada com sucesso para ${to}`);
            }
        } catch (err: any) {
            logger.error(`[WhatsApp] Erro de rede ao enviar para ${to}`, { error: err?.message });
        }
    }
};

export const initNotificationService = () => {
  // Escuta por eventos da rota /notify
  eventBus.on('notification:send', (message: string) => {
    sendWhatsAppText(message);
  });

  logger.info('✅ Serviço de Notificações inicializado e pronto para enviar mensagens.');
};