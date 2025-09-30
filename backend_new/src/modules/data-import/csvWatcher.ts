import fs from 'fs';
import path from 'path';
import chokidar from 'chokidar';
import { parse } from 'csv-parse';
import { logger } from '../../core/logger';
import { prisma } from '../../core/prisma';
import { eventBus, EVENTS } from '../../core/eventBus';

export const initCsvWatcher = () => {
  const csvDir = process.env.CSV_DIR || path.resolve(process.cwd(), 'dados');
  if (!fs.existsSync(csvDir)) {
    logger.warn(`Diretório de CSV não encontrado: ${csvDir}. A importação automática está desabilitada.`);
    return;
  }

  const watcher = chokidar.watch(`${csvDir}/*.csv`, {
    persistent: true,
    ignoreInitial: false,
    usePolling: true,
    interval: 5000,
    awaitWriteFinish: {
      stabilityThreshold: 2000,
      pollInterval: 100,
    },
  });

  const processFile = async (filePath: string) => {
    logger.info(`Arquivo CSV detectado: ${path.basename(filePath)}`);
    const fileContent = fs.readFileSync(filePath, 'utf8');

    const parser = parse(fileContent, {
      delimiter: [',', ';'],
      columns: true,
      skip_empty_lines: true,
      trim: true,
    });

    const records = [];
    for await (const record of parser) {
      records.push(record);
    }

    if (records.length === 0) return;

    const fileName = path.basename(filePath, '.csv');
    const symbol = fileName.slice(0, 3).toUpperCase(); // Ex: WINM5 -> WIN
    const timeframe = fileName.slice(3).toUpperCase(); // Ex: WINM5 -> M5

    let instrument = await prisma.instrument.findUnique({ where: { symbol } });
    if (!instrument) {
      instrument = await prisma.instrument.create({ data: { symbol, name: symbol } });
    }

    const candleData = records.map(rec => {
        const timeStr = `${rec.date}T${rec.time}Z`;
        return {
            instrumentId: instrument!.id,
            timeframe,
            time: new Date(timeStr),
            open: parseFloat(rec.open),
            high: parseFloat(rec.high),
            low: parseFloat(rec.low),
            close: parseFloat(rec.close),
            volume: parseInt(rec.tick_volume, 10) || 0,
        };
    });

    try {
      const result = await prisma.candle.createMany({
        data: candleData,
        skipDuplicates: true,
      });
      logger.info(`${result.count} novos candles importados para ${symbol} ${timeframe}`);

      if (result.count > 0) {
        // Dispara o evento para o motor de estratégia analisar os novos dados
        eventBus.emit(EVENTS.NEW_CANDLE_DATA, { symbol, timeframe });
      }

    } catch (error) {
      logger.error('Erro ao salvar candles no banco de dados', error);
    }
  };

  watcher
    .on('add', processFile)
    .on('change', processFile)
    .on('error', (error) => logger.error('Erro no CSV Watcher', error));

  logger.info(`🔎 CSV Watcher monitorando a pasta: ${csvDir}`);
};