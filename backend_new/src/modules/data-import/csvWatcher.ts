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
  if (!fs.existsSync(filePath)) {
    logger.warn(`[CSV] Ficheiro ${path.basename(filePath)} não encontrado no momento do processamento.`);
    return;
  }
  logger.info(`[CSV] A processar o ficheiro: ${path.basename(filePath)}`);

  const fileName = path.basename(filePath);
  const match = fileName.match(/^([A-Z]+)(M\d+|H\d+)\.csv$/i);
  if (!match) {
    logger.warn(`[CSV] Ficheiro ${fileName} ignorado (nome fora do padrão esperado, ex: WINM1.csv).`);
    return;
  }

  const symbol = match[1].toUpperCase();
  const importTimeframe = 'M1';
  logger.info(`[CSV] Símbolo Identificado: ${symbol}. A forçar importação no timeframe base: ${importTimeframe}`);

  try {
    const instrument = await prisma.instrument.upsert({
      where: { symbol: symbol },
      update: {},
      create: { symbol: symbol, name: symbol },
    });

    const fileContent = fs.readFileSync(filePath, 'utf-8');
    if (!fileContent.trim()) {
      logger.warn(`[CSV] O ficheiro ${fileName} está vazio.`);
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
      logger.warn(`[CSV] Nenhum registo válido encontrado em ${fileName}.`);
      return;
    }

    const candleData = records.map(rec => {
      const timeValue = rec.time;
      if (!timeValue) return null;

      const time = new Date(timeValue.replace(/\./g, '-'));
      if (isNaN(time.getTime())) {
        logger.warn(`[CSV] Data inválida encontrada e ignorada: ${timeValue}`);
        return null;
      }

      const volumeValue = rec.volume || rec.tick_volume;

      return {
        instrumentId: instrument.id,
        timeframe: importTimeframe,
        time,
        open: parseFloat(rec.open),
        high: parseFloat(rec.high),
        low: parseFloat(rec.low),
        close: parseFloat(rec.close),
        volume: parseInt(volumeValue, 10) || 0,
      };
    }).filter((c): c is NonNullable<typeof c> => c !== null && !isNaN(c.open));

    logger.info(`[CSV] Foram analisados ${records.length} registos. Foram encontrados ${candleData.length} candles válidos para inserir.`);

    if (candleData.length > 0) {
      logger.info(`[CSV] A inserir/atualizar ${candleData.length} candles de ${symbol} como ${importTimeframe} usando 'upsert'...`);

      let upsertedCount = 0;
      for (const candle of candleData) {
        // <<< CORREÇÃO DA SINTAXE DO PRISMA UPSERT >>>
        await prisma.candle.upsert({
          where: {
            instrument_time_tf_unique: { // Nome correto do índice
              instrumentId: candle.instrumentId,
              timeframe: candle.timeframe,
              time: candle.time,
            }
          },
          update: {
            open: candle.open,
            high: candle.high,
            low: candle.low,
            close: candle.close,
            volume: candle.volume,
          },
          create: candle,
        });
        upsertedCount++;
      }

      logger.info(`[CSV] ${upsertedCount} candles inseridos/atualizados.`);
      if (upsertedCount > 0) {
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
    ignoreInitial: true,
    usePolling: true,
    interval: 5000,
    awaitWriteFinish: true,
  });

  watcher
    .on('ready', async () => {
      logger.info(`[CSV] Monitorização pronta. A verificar ficheiros existentes em: ${DATA_DIR}`);

      const watchedPaths = watcher.getWatched();
      const processPromises: Promise<void>[] = [];

      for (const dir in watchedPaths) {
        for (const fileName of watchedPaths[dir]) {
          const fullPath = path.join(dir, fileName);
          logger.info(`[CSV] Ficheiro existente encontrado no arranque: ${fileName}`);
          processPromises.push(processFile(fullPath));
        }
      }

      await Promise.all(processPromises);

      logger.info(`[CSV] Processamento inicial concluído. A aguardar por novas alterações...`);

      watcher.on('add', processFile);
      watcher.on('change', processFile);
    })
    .on('error', (error) => logger.error(`[CSV] Erro no watcher:`, error));
};