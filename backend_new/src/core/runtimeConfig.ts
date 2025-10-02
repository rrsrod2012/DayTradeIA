// ===============================
// FILE: backend_new/src/core/runtimeConfig.ts
// ===============================
import fs from 'fs';
import path from 'path';
import { logger } from './logger';

export type RuntimeConfig = {
    uiTimeframe?: "M1" | "M5" | "M15" | "M30" | "H1";
    uiLots?: number;
    rr?: number;
    slAtr?: number;
    beAtPts?: number;
    beOffsetPts?: number;
    entryDelayBars?: number;
    decisionThreshold?: number;
    debug?: boolean;
};

const configFilePath = path.resolve(process.cwd(), 'runtime_config.json');
let config: RuntimeConfig = {};

// Carrega a configuração do arquivo no início
try {
    if (fs.existsSync(configFilePath)) {
        const fileContent = fs.readFileSync(configFilePath, 'utf-8');
        config = JSON.parse(fileContent);
        logger.info(`[Config] Configuração de runtime carregada de ${configFilePath}`);
    } else {
        logger.info(`[Config] Nenhum arquivo de configuração de runtime encontrado. Usando valores padrão.`);
    }
} catch (error) {
    logger.error(`[Config] Falha ao carregar configuração de runtime de ${configFilePath}`, error);
}

const saveConfigToFile = () => {
    try {
        fs.writeFileSync(configFilePath, JSON.stringify(config, null, 2), 'utf-8');
    } catch (error) {
        logger.error(`[Config] Falha ao salvar configuração de runtime em ${configFilePath}`, error);
    }
};

export const getRuntimeConfig = (): RuntimeConfig => {
    return config;
};

export const updateRuntimeConfig = (newConfig: Partial<RuntimeConfig>): RuntimeConfig => {
    config = { ...config, ...newConfig };
    saveConfigToFile();
    logger.info('[Config] Configuração de runtime atualizada', config);
    return config;
};