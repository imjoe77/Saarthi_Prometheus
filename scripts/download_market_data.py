from __future__ import annotations

import calendar
import sys
import time
import urllib.error
import urllib.request
from datetime import date, timedelta
from pathlib import Path


BASE_URL = "https://data.binance.vision/data/spot"

SYMBOLS = [
    "BTCUSDT",
    "ETHUSDT",
    "SOLUSDT",
]

INTERVAL = "1d"

START_DATE = date(2025, 1, 1)
END_DATE = date(2026, 10, 6)

PROJECT_ROOT = Path(__file__).resolve().parents[1]
OUTPUT_ROOT = PROJECT_ROOT / "data" / "market" / "raw"


def download_file(url: str, destination: Path) -> bool:
    if destination.exists():
        print(f"[SKIP] {destination.relative_to(PROJECT_ROOT)}")
        return True

    destination.parent.mkdir(parents=True, exist_ok=True)

    print(f"[GET ] {url}")

    try:
        urllib.request.urlretrieve(url, destination)
        print(f"[ OK ] {destination.relative_to(PROJECT_ROOT)}")
        return True

    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            print(f"[MISS] Not available: {url}")

            if destination.exists():
                destination.unlink()

            return False

        print(f"[ERR ] HTTP {exc.code}: {url}")

    except urllib.error.URLError as exc:
        print(f"[ERR ] Network error: {exc}")

    except Exception as exc:
        print(f"[ERR ] {type(exc).__name__}: {exc}")

    if destination.exists():
        destination.unlink()

    return False


def month_start(year: int, month: int) -> date:
    return date(year, month, 1)


def next_month(year: int, month: int) -> tuple[int, int]:
    if month == 12:
        return year + 1, 1

    return year, month + 1


def download_monthly(symbol: str, year: int, month: int) -> bool:
    month_text = f"{year:04d}-{month:02d}"

    filename = f"{symbol}-{INTERVAL}-{month_text}.zip"

    url = (
        f"{BASE_URL}/monthly/klines/"
        f"{symbol}/{INTERVAL}/{filename}"
    )

    destination = OUTPUT_ROOT / symbol / filename

    return download_file(url, destination)


def download_daily(symbol: str, current_date: date) -> bool:
    date_text = current_date.isoformat()

    filename = f"{symbol}-{INTERVAL}-{date_text}.zip"

    url = (
        f"{BASE_URL}/daily/klines/"
        f"{symbol}/{INTERVAL}/{filename}"
    )

    destination = OUTPUT_ROOT / symbol / filename

    return download_file(url, destination)


def download_symbol(symbol: str) -> None:
    print()
    print("=" * 70)
    print(f"Downloading {symbol}")
    print("=" * 70)

    # ------------------------------------------------------------------
    # Completed months
    #
    # Download monthly archives for every complete month in our range.
    # ------------------------------------------------------------------

    first_month = month_start(START_DATE.year, START_DATE.month)

    # Month containing END_DATE.
    last_month = month_start(END_DATE.year, END_DATE.month)

    year = first_month.year
    month = first_month.month

    while True:
        this_month = month_start(year, month)

        # Don't use the monthly archive for a partial/future month.
        if this_month >= last_month:
            break

        download_monthly(symbol, year, month)

        year, month = next_month(year, month)

    # ------------------------------------------------------------------
    # Current/partial month
    #
    # Download daily archives for the remaining dates.
    # ------------------------------------------------------------------

    partial_month_start = last_month

    current = partial_month_start

    while current <= END_DATE:
        download_daily(symbol, current)

        current += timedelta(days=1)

        # Small delay so we don't hammer the public data host.
        time.sleep(0.1)


def write_readme() -> None:
    readme = OUTPUT_ROOT.parent / "README.md"

    content = """# Prometheus Historical Market Data

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
"""

    readme.write_text(content, encoding="utf-8")

    print()
    print(f"[ OK ] Wrote {readme.relative_to(PROJECT_ROOT)}")


def main() -> int:
    print("=" * 70)
    print("PROMETHEUS HISTORICAL MARKET DATA DOWNLOADER")
    print("=" * 70)

    print(f"Symbols : {', '.join(SYMBOLS)}")
    print(f"Interval: {INTERVAL}")
    print(f"Start   : {START_DATE}")
    print(f"End     : {END_DATE}")
    print(f"Output  : {OUTPUT_ROOT}")

    OUTPUT_ROOT.mkdir(parents=True, exist_ok=True)

    for symbol in SYMBOLS:
        download_symbol(symbol)

    write_readme()

    print()
    print("=" * 70)
    print("DOWNLOAD COMPLETE")
    print("=" * 70)

    return 0


if __name__ == "__main__":
    sys.exit(main())