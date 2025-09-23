import React from 'react';

type Log = {
    ts: number;
    level: 'info' | 'warn' | 'error';
    tag: string;
    msg: string;
    data?: any;
};

export default function OrderLogsModal({
    taskId,
    onClose,
}: { taskId: string; onClose: () => void }) {
    const [logs, setLogs] = React.useState<Log[] | null>(null);
    const [err, setErr] = React.useState<string | null>(null);

    React.useEffect(() => {
        let alive = true;
        (async () => {
            try {
                const res = await fetch(`/logs/by-task/${encodeURIComponent(taskId)}`);
                const j = await res.json();
                if (!alive) return;
                if (!j.ok) throw new Error('Erro ao buscar logs');
                setLogs(j.logs || []);
            } catch (e: any) {
                setErr(e?.message || 'Falha ao carregar');
            }
        })();
        return () => {
            alive = false;
        };
    }, [taskId]);

    const fmt = (ts: number) =>
        new Intl.DateTimeFormat('pt-BR', {
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
                            <div className="mb-2 text-muted small">taskId: {taskId}</div>
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
