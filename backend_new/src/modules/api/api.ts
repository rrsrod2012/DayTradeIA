import { Express, Request, Response } from 'express';
import { prisma } from '../../core/prisma';
import { initTradesRoutes } from './tradesRoutes';

export const initApi = (app: Express) => {
  // Inicializa as rotas específicas para trades
  initTradesRoutes(app);

  // Rota para buscar sinais confirmados
  app.get('/api/signals/confirmed', async (req: Request, res: Response) => {
    const { symbol, timeframe, from, to } = req.query;
    
    // Adicionar lógica de busca de sinais confirmados do banco de dados aqui
    // similar à que existia no seu `routesAdmin.ts` original.
    
    res.json({ message: 'Endpoint de Sinais Confirmados - A ser implementado', query: req.query });
  });

  // Rota para buscar sinais projetados (agora pode ser integrada com o StrategyEngine)
  app.get('/api/signals/projected', async (req: Request, res: Response) => {
    // Adicionar lógica de busca de sinais projetados aqui
    // Pode chamar uma função que simula a estratégia com os parâmetros recebidos
    
    res.json({ message: 'Endpoint de Sinais Projetados - A ser implementado', query: req.query });
  });
  
  // Rota para buscar candles para o gráfico
  app.get('/api/candles', async (req: Request, res: Response) => {
    const { symbol, timeframe } = req.query;
    if (!symbol || !timeframe) {
        return res.status(400).json({ error: 'Parâmetros symbol e timeframe são obrigatórios.'});
    }

    const instrument = await prisma.instrument.findUnique({ where: { symbol: String(symbol) }});
    if (!instrument) {
        return res.status(404).json({ error: 'Instrumento não encontrado.'});
    }

    const candles = await prisma.candle.findMany({
        where: {
            instrumentId: instrument.id,
            timeframe: String(timeframe)
        },
        orderBy: { time: 'asc' },
        take: 1000 // Limite para evitar sobrecarga, pode ser ajustado
    });

    res.json(candles);
  });
};