import React, { createContext, useContext, useState } from "react";

type Filters = {
    symbol: string;
    timeframe: string;
    from: string | null;
    to: string | null;
};

type Ctx = {
    filters: Filters;
    setFilters: (f: Partial<Filters>) => void;
};

const AIControlsContext = createContext<Ctx | undefined>(undefined);

export function AIControlsProvider({ children }: { children: React.ReactNode }) {
    const [filters, setFiltersState] = useState<Filters>({
        symbol: "WIN",
        timeframe: "M5",
        from: null,
        to: null,
    });

    function setFilters(update: Partial<Filters>) {
        setFiltersState((prev) => ({ ...prev, ...update }));
    }

    return (
        <AIControlsContext.Provider value={{ filters, setFilters }}>
            {children}
        </AIControlsContext.Provider>
    );
}

export function useAIControls() {
    const ctx = useContext(AIControlsContext);
    if (!ctx) throw new Error("useAIControls deve ser usado dentro do AIControlsProvider");
    return ctx;
}
