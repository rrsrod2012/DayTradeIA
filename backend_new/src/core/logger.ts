// Um logger simples para manter os logs consistentes
const log = (level: 'info' | 'warn' | 'error', message: string, data?: object) => {
  const timestamp = new Date().toISOString();
  console.log(JSON.stringify({ timestamp, level, message, ...data }));
};

export const logger = {
  info: (message: string, data?: object) => log('info', message, data),
  warn: (message: string, data?: object) => log('warn', message, data),
  error: (message: string, error?: any) => {
    const data = error instanceof Error ? { error: error.message, stack: error.stack } : { error };
    log('error', message, data);
  },
};