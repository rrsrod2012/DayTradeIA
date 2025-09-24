import React from 'react';

type RawLog = {
    at: string | null;            // ISO vindo do backend
    taskId: string | null;
    entrySignalId: number | null;
    level: string | null;         // "info" | "warn" | "error" | ...
    type: string | null;          // "order_ok" | "order_fail" | "market_closed" | ...
    message: string | null;
    data: any | null;
    symbol: string | null;
    price: number | null;
    brokerOrderId: string | null;
};

type Log = {
    ts: number | null;            // timestamp em ms (para formatação)
    level: 'info' | 'warn' | 'error' | string;
    tag: string;                  // usamos o "type" como tag principal
    msg: string;
    data?: any;
};

export default function OrderLogsModal({
    taskId,
    onClose,
}: { taskId: string; onClose: () => void }) {
    const [logs, setLogs] = React.useState<Log[] | null>(null);
    const [err, setErr] = React.useState<string | null>(null);
    const [meta, setMeta] = React.useState<{ count: number; modelUsed?: string | null } | null>(null);

    const load = React.useCallback(async () => {
        setErr(null);
        setLogs(null);
        try {
            const url = `/api/order-logs?taskId=${encodeURIComponent(taskId)}&limit=500`;
            const res = await fetch(url, { method: 'GET' });
            const j = await res.json();

            if (!j || j.ok === false) {
                throw new Error(j?.error || 'Erro ao buscar logs');
            }

            const arr: RawLog[] = Array.isArray(j?.logs) ? j.logs : [];
            const mapped: Log[] = arr.map((l) => {
                const ts = l?.at ? new Date(l.at).getTime() : null;
                // normaliza level
                const lvl = (l?.level || 'info').toLowerCase();
                const level: Log['level'] =
                    lvl === 'error' ? 'error' : lvl === 'warn' || lvl === 'warning' ? 'warn' : 'info';

                // tag (preferimos o tipo do evento)
                const tag = l?.type || 'event';

                // mensagem amigável
                const baseMsg =
                    l?.message ||
                    (l?.type ? `Evento: ${l.type}` : 'Evento de ordem');

                const extras: string[] = [];
                if (l?.symbol) extras.push(`symbol=${l.symbol}`);
                if (typeof l?.price === 'number') extras.push(`price=${l.price}`);
                if (l?.brokerOrderId) extras.push(`orderId=${l.brokerOrderId}`);

                const msg = extras.length ? `${baseMsg} (${extras.join(' • ')})` : baseMsg;

                return { ts, level, tag, msg, data: l?.data };
            });

            // ordena mais recente primeiro
            mapped.sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));
            setLogs(mapped);
            setMeta({ count: j?.count ?? mapped.length, modelUsed: j?.modelUsed ?? null });
        } catch (e: any) {
            setErr(e?.message || 'Falha ao carregar');
            setLogs([]);
        }
    }, [taskId]);

    React.useEffect(() => {
        let alive = true;
        (async () => {
            await load();
            if (!alive) return;
        })();
        return () => {
            alive = false;
        };
    }, [load]);

    const fmt = (ts: number | null) =>
        ts == null
            ? '-'
            : new Intl.DateTimeFormat('pt-BR', {
                year: '2-digit',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
            }).format(new Date(ts));

    return (
        <div className="modal-backdrop show" style={{ display: 'block' }}>
            <div className="modal d-block" tabIndex={-1} onClick={onClose}>
                <div className="modal-dialog modal-lg" onClick={(e) => e.stopPropagation()}>
                    <div className="modal-content">
                        <div className="modal-header">
                            <h6 className="modal-title">Logs da ordem</h6>
                            <button className="btn-close" onClick={onClose} />
                        </div>
                        <div className="modal-body" style={{ maxHeight: '60vh', overflow: 'auto' }}>
                            <div className="d-flex justify-content-between align-items-center mb-2">
                                <div className="text-muted small">
                                    taskId: <code>{taskId}</code>
                                    {meta?.modelUsed ? (
                                        <>
                                            {' '}• origem: <code>{meta.modelUsed}</code>
                                        </>
                                    ) : null}
                                    {meta?.count != null ? (
                                        <>
                                            {' '}• itens: <b>{meta.count}</b>
                                        </>
                                    ) : null}
                                </div>
                                <button className="btn btn-sm btn-outline-secondary" onClick={load}>
                                    Recarregar
                                </button>
                            </div>

                            {err && <div className="alert alert-danger">{err}</div>}
                            {!logs && !err && <div>Carregando...</div>}
                            {logs && logs.length === 0 && (
                                <div className="text-muted">Nenhum log encontrado.</div>
                            )}

                            {logs && logs.length > 0 && (
                                <ul className="list-group">
                                    {logs.map((l, i) => (
                                        <li key={i} className="list-group-item d-flex align-items-start">
                                            <div className="me-3">
                                                <span
                                                    className={
                                                        'badge ' +
                                                        (l.level === 'error'
                                                            ? 'bg-danger'
                                                            : l.level === 'warn'
                                                                ? 'bg-warning text-dark'
                                                                : 'bg-secondary')
                                                    }
                                                >
                                                    {l.level}
                                                </span>
                                            </div>
                                            <div className="flex-grow-1">
                                                <div className="small text-muted">
                                                    {fmt(l.ts)} • {l.tag}
                                                </div>
                                                <div>{l.msg}</div>
                                                {l.data && (
                                                    <pre
                                                        className="mt-1 mb-0 small bg-light p-2 rounded"
                                                        style={{ whiteSpace: 'pre-wrap' }}
                                                    >
                                                        {JSON.stringify(l.data, null, 2)}
                                                    </pre>
                                                )}
                                            </div>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </div>
                        <div className="modal-footer">
                            <button className="btn btn-outline-secondary" onClick={onClose}>
                                Fechar
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
