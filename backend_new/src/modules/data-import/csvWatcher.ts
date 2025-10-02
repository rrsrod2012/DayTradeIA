// ===============================
// FILE: backend_new/src/modules/data-import/csvWatcher.ts
// ===============================
import chokidar from 'chokidar';
import fs from 'fs';
import path from 'path';
import { parse } from 'csv-parse';
import { prisma } from '../../core/prisma';
import { logger } from '../../core/logger';
import { eventBus, EVENTS } from '../../core/eventBus';

const DATA_DIR = process.env.CSV_DIR || path.resolve(process.cwd(), 'dados');

const processFile = async (filePath: string) => {
  logger.info(`[CSV] Processando arquivo: ${path.basename(filePath)}`);

  const fileName = path.basename(filePath);
  const match = fileName.match(/^([A-Z]+)(M\d+|H\d+)\.csv$/i);
  if (!match) {
    logger.warn(`[CSV] Arquivo ${fileName} ignorado (nome fora do padrão esperado, ex: WINM1.csv).`);
    return;
  }

  // <<< ALTERAÇÃO PRINCIPAL AQUI >>>
  // Ignoramos o timeframe do nome do arquivo e forçamos a importação como M1.
  const symbol = match[1].toUpperCase();
  const importTimeframe = 'M1';
  logger.info(`[CSV] Identificado Symbol: ${symbol}. Forçando importação no timeframe base: ${importTimeframe}`);

  try {
    const instrument = await prisma.instrument.upsert({
      where: { symbol: symbol },
      update: {},
      create: { symbol: symbol, name: symbol },
    });

    const fileContent = fs.readFileSync(filePath, 'utf-8');
    if (!fileContent.trim()) {
      logger.warn(`[CSV] Arquivo ${fileName} está vazio.`);
      return;
    }

    const records: any[] = await new Promise((resolve, reject) => {
      const parsedRecords: any[] = [];
      const parser = parse({
        delimiter: ';',
        columns: header => header.map((h: string) => h.toLowerCase().trim()),
        trim: true,
        skip_empty_lines: true,
      });

      parser.on('readable', () => {
        let record;
        while ((record = parser.read()) !== null) {
          parsedRecords.push(record);
        }
      });
      parser.on('error', reject);
      parser.on('end', () => resolve(parsedRecords));

      parser.write(fileContent);
      parser.end();
    });

    if (records.length === 0) {
      logger.warn(`[CSV] Nenhum registro válido encontrado em ${fileName}.`);
      return;
    }

    const candleData = records.map(rec => {
      const timeValue = rec.date && rec.time ? `${rec.date} ${rec.time}` : null;
      if (!timeValue) return null;

      const time = new Date(timeValue.replace(/\./g, '-'));
      if (isNaN(time.getTime())) return null;

      const volumeValue = rec.tick_volume || rec.volume;

      return {
        instrumentId: instrument.id,
        timeframe: importTimeframe, // Salva sempre como M1
        time,
        open: parseFloat(rec.open),
        high: parseFloat(rec.high),
        low: parseFloat(rec.low),
        close: parseFloat(rec.close),
        volume: parseInt(volumeValue, 10) || 0,
      };
    }).filter((c): c is NonNullable<typeof c> => c !== null && !isNaN(c.open));

    if (candleData.length > 0) {
      logger.info(`[CSV] Inserindo/atualizando ${candleData.length} candles de ${symbol} como ${importTimeframe}...`);
      const result = await prisma.candle.createMany({
        data: candleData,
        skipDuplicates: true,
      });
      logger.info(`[CSV] ${result.count} novos candles M1 inseridos.`);
      if (result.count > 0) {
        // Notifica o sistema que novos dados M1 estão disponíveis
        eventBus.emit(EVENTS.NEW_CANDLE_DATA, { symbol: symbol, timeframe: importTimeframe });
      }
    }
  } catch (error: any) {
    logger.error(`[CSV] Falha ao processar ${fileName}:`, error.message);
  }
};

export const initCsvWatcher = () => {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  const watcher = chokidar.watch(`${DATA_DIR}/*.csv`, {
    persistent: true,
    ignoreInitial: false,
    usePolling: true,
    interval: 5000,
    awaitWriteFinish: {
      stabilityThreshold: 2000,
      pollInterval: 100,
    },
  });

  watcher
    .on('ready', () => {
      logger.info(`[CSV] Monitoramento iniciado e pronto. Escutando por alterações em: ${DATA_DIR}`);
      watcher.on('add', processFile);
      watcher.on('change', processFile);
    })
    .on('error', (error) => logger.error(`[CSV] Erro no watcher:`, error));
};