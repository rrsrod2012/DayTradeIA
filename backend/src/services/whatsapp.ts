// backend/src/services/whatsapp.ts
import fetch from "node-fetch";

const WA_TOKEN = process.env.WHATSAPP_TOKEN || "";
const WA_PHONEID = process.env.WHATSAPP_PHONE_ID || ""; // phone-number-id da Cloud API
const WA_TO_LIST = (process.env.WHATSAPP_TO || "").split(",").map(s => s.trim()).filter(Boolean);

/**
 * Envia um texto via WhatsApp Cloud API.
 * Requisitos:
 *   - WHATSAPP_TOKEN=<permanent/user token>
 *   - WHATSAPP_PHONE_ID=<phone-number-id>
 *   - WHATSAPP_TO="+55XXXXXXXXXXX,[,+55YYYY...]"
 */
export async function sendWhatsAppText(text: string) {
    if (!WA_TOKEN || !WA_PHONEID || WA_TO_LIST.length === 0) {
        console.warn("[whatsapp] credenciais/números ausentes; skip:", { hasToken: !!WA_TOKEN, hasPhoneId: !!WA_PHONEID, to: WA_TO_LIST.length });
        return;
    }
    const url = `https://graph.facebook.com/v19.0/${WA_PHONEID}/messages`;

    const results: Array<{ to: string; ok: boolean; status: number; body?: any; err?: any }> = [];
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
                    to,                 // ex.: "+55XXXXXXXXXXX"
                    type: "text",
                    text: { body: text }
                }),
            });
            const body = await res.json().catch(() => ({}));
            results.push({ to, ok: res.ok, status: res.status, body });
        } catch (err) {
            results.push({ to, ok: false, status: -1, err });
        }
    }
    console.log("[whatsapp] sent:", results);
}
