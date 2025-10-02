// ===============================
// FILE: frontend/src/components/OrderLogsModal.tsx
// ===============================
import React, { useEffect, useState } from 'react';
import { Modal, Button, Table, Spinner, Alert } from 'react-bootstrap';
import { fetchOrderLogs, OrderLogEntry } from '../services/api';
import { formatToLocal } from '../core/dateUtils'; // <<< NOVA IMPORTAÇÃO

type Props = {
    show: boolean;
    handleClose: () => void;
    orderKey: string | number | null;
};

export default function OrderLogsModal({ show, handleClose, orderKey }: Props) {
    const [logs, setLogs] = useState<OrderLogEntry[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (show && orderKey) {
            setLoading(true);
            setError(null);
            fetchOrderLogs(orderKey)
                .then(res => {
                    if (res.ok) setLogs(res.logs || []);
                    else setError("Resposta da API não foi 'ok'.");
                })
                .catch(e => setError(e.message || "Erro ao buscar logs."))
                .finally(() => setLoading(false));
        }
    }, [show, orderKey]);

    return (
        <Modal show={show} onHide={handleClose} size="lg">
            <Modal.Header closeButton>
                <Modal.Title>Logs da Ordem: <code>{orderKey}</code></Modal.Title>
            </Modal.Header>
            <Modal.Body>
                {loading && <div className="text-center"><Spinner animation="border" /></div>}
                {error && <Alert variant="danger">{error}</Alert>}
                {!loading && !error && (
                    <Table striped bordered hover size="sm">
                        <thead>
                            <tr>
                                <th>Horário</th>
                                <th>Tipo</th>
                                <th>Mensagem</th>
                                <th>Preço</th>
                                <th>ID Broker</th>
                            </tr>
                        </thead>
                        <tbody>
                            {logs.map((log, idx) => (
                                <tr key={idx}>
                                    {/* <<< CORREÇÃO DE FORMATAÇÃO DE DATA/HORA >>> */}
                                    <td>{formatToLocal(log.at)}</td>
                                    <td><Badge bg="info">{log.type || 'log'}</Badge></td>
                                    <td>{log.message}</td>
                                    <td>{log.price}</td>
                                    <td>{log.brokerOrderId}</td>
                                </tr>
                            ))}
                        </tbody>
                    </Table>
                )}
            </Modal.Body>
            <Modal.Footer>
                <Button variant="secondary" onClick={handleClose}>
                    Fechar
                </Button>
            </Modal.Footer>
        </Modal>
    );
}