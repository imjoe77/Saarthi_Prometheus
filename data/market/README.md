# Prometheus Historical Market Data

## Source

Binance Public Market Data:
https://data.binance.vision/

## Dataset

- Market: Binance Spot
- Symbols: BTCUSDT, ETHUSDT, SOLUSDT
- Interval: 1 day (`1d`)
- Start date: 2025-01-01
- End date: 2026-10-06
- Data type: OHLCV / Binance kline data

## Download strategy

Completed months are stored using Binance monthly kline archives.

The current partial month is stored using Binance daily kline archives.

Only the `.zip` market-data archives are downloaded. `.CHECKSUM` files are not
downloaded by this script.

## Prometheus usage

The market data is real historical Binance market data.

Strategy trades will be simulated by Prometheus for demonstration and
backtesting purposes.

There are no real Prometheus users, expert traders, or real-money trades in
this simulation.

Strategy equity will be derived from simulated strategy trades and historical
market prices.

The Prometheus Risk Engine will calculate risk from the resulting equity
series.

## Important

Raw downloaded archives should not be manually modified.
