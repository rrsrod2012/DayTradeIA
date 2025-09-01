import React from "react";
import { Card } from "react-bootstrap";

type Props = { pnlPoints: number; pnlMoney: number };

export default function PnLSummary({ pnlPoints, pnlMoney }: Props) {
  const moneyFmt = pnlMoney.toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
  return (
    <Card>
      <Card.Body>
        <Card.Title>Resumo PnL</Card.Title>
        <div>
          Pontos acumulados: <strong>{pnlPoints.toFixed(0)}</strong>
        </div>
        <div>
          Resultado: <strong>{moneyFmt}</strong>
        </div>
      </Card.Body>
    </Card>
  );
}
