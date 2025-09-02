-- Mantém o menor id de cada tripla
DELETE FROM Signal
WHERE id NOT IN (
  SELECT MIN(id)
  FROM Signal
  GROUP BY candleId, signalType, side
);

-- Conferir se zerou
SELECT candleId, signalType, side, COUNT(*) AS cnt
FROM Signal
GROUP BY candleId, signalType, side
HAVING cnt > 1;
