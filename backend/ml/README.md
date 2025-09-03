# daytrade-ia — Micro-Modelo (IA)

Este diretório contém um pipeline simples para **treinar** um classificador que prevê a
probabilidade de o preço atingir **TP antes de SL** em um horizonte fixo (triple-barrier).
O modelo é servido via **FastAPI** em `/predict`.

## Requisitos

- Python 3.10+
- `pip install -r requirements.txt`

## Dados de treino

O script espera um CSV com colunas: `time, open, high, low, close, volume`.
- `time` em ISO ou "YYYY-mm-dd HH:MM:SS" (assumido UTC ou local consistente).
- Se preferir, exporte do seu backend (M1/M5) ou use seus CSVs originais.

## Treinar

Exemplo (M5, horizonte=8 candles, SL=1×ATR, TP=2×ATR):

```bash
python ml/train.py --csv path/to/WIN_M5.csv --timeframe M5 --horizon 8 --atr 14 --k_sl 1.0 --k_tp 2.0
