import React from "react";

type Props = {
    onApply: (params: { minProb: number; minEV: number; cooldown: number }) => void;
};

/**
 * Perfis de risco prontos: Conservador / Padrão / Agressivo
 * Aplica ajustes típicos de filtros de entrada.
 *
 * Exemplo de uso:
 * <RiskProfiles onApply={({minProb, minEV, cooldown}) => {
 *   aiStore.setMinProb(minProb);
 *   aiStore.setMinEV(minEV);
 *   aiStore.setCooldown(cooldown);
 * }} />
 */
export default function RiskProfiles({ onApply }: Props) {
    const apply = (name: "conservative" | "standard" | "aggressive") => {
        if (name === "conservative") {
            onApply({ minProb: 0.68, minEV: 0.20, cooldown: 5 });
        } else if (name === "standard") {
            onApply({ minProb: 0.62, minEV: 0.10, cooldown: 4 });
        } else {
            onApply({ minProb: 0.55, minEV: 0.00, cooldown: 3 });
        }
    };

    return (
        <div className="flex gap-2 items-center p-2 rounded-xl border border-gray-200 shadow-sm">
            <span className="font-semibold">Perfis de risco:</span>
            <button
                className="px-3 py-1 rounded-lg border hover:opacity-80"
                onClick={() => apply("conservative")}
                title="Menos sinais, maior seletividade"
            >
                Conservador
            </button>
            <button
                className="px-3 py-1 rounded-lg border hover:opacity-80"
                onClick={() => apply("standard")}
                title="Equilíbrio entre quantidade e qualidade"
            >
                Padrão
            </button>
            <button
                className="px-3 py-1 rounded-lg border hover:opacity-80"
                onClick={() => apply("aggressive")}
                title="Mais sinais, maior exposição a whipsaw"
            >
                Agressivo
            </button>
        </div>
    );
}
