"""
TITAN·MT5 Bridge Server  v2.0
==============================
FastAPI server bridging the dashboard/agent to your local MT5 terminal.
Run this on the same PC as MetaTrader 5.

Requirements:
  pip install fastapi uvicorn MetaTrader5 anthropic python-dotenv

Usage:
  python mt5_bridge.py

Starts on http://localhost:8000

── Guardrails in this version ───────────────────────────────────────────
  1. SAFE MODE         — locks lot size to 0.01, overrides everything else
  2. Fixed lot size    — hard-coded fallback, never auto-calculated in safe mode
  3. Daily loss limit  — kill switch: blocks new trades if daily drawdown >= X%
  4. Max loss per trade — rejects any trade whose SL risk exceeds hard cap ($)
  5. Max positions cap — hard ceiling, no exceptions
  6. Min AI confidence — agent won't fire below threshold
  7. Consecutive loss  — pauses agent after N losses in a row
"""

import os
import json
import sqlite3
from datetime import datetime, date
from typing import Optional
from contextlib import asynccontextmanager, closing

import MetaTrader5 as mt5
import anthropic
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from dotenv import load_dotenv

load_dotenv()

# ── Credentials ────────────────────────────────────────────────────────────────

MT5_LOGIN     = int(os.getenv("MT5_LOGIN", "0") or "0")
MT5_PASSWORD  = os.getenv("MT5_PASSWORD", "")
MT5_SERVER    = os.getenv("MT5_SERVER", "")
ANTHROPIC_KEY = os.getenv("ANTHROPIC_API_KEY", "")

WATCHED_SYMBOLS = ["XAUUSDm", "EURUSDm", "USDZARm", "XAGUSDm", "USOILm"]

# ── Risk Configuration ─────────────────────────────────────────────────────────
# Edit these defaults. All can also be changed at runtime via PUT /config.

RISK_CONFIG = {
    # ── Safe Mode (most important) ──────────────────────────────────────────
    "safe_mode": True,           # TRUE = always trade 0.01 lots, no exceptions
    "fixed_lots": 0.01,          # Lot size used when safe_mode is True

    # ── Dynamic sizing (only used when safe_mode = False) ───────────────────
    "risk_pct": 0.5,             # % of balance risked per trade
    "sl_pips": 50,               # Default stop-loss distance in pips

    # ── Trade quality filters ───────────────────────────────────────────────
    "min_confidence": 80,        # Agent only fires if confidence >= this %
    "tp_ratio": 2.0,             # Take-profit ratio (2 = 2:1 R:R)

    # ── Position limits ─────────────────────────────────────────────────────
    "max_positions": 3,          # Hard cap on simultaneous open trades

    # ── Daily loss kill switch ──────────────────────────────────────────────
    "max_daily_loss_pct": 3.0,   # Halt new trades if day's loss >= X% of balance
    "max_loss_per_trade_usd": 10.0,  # Reject any trade where SL risk > this amount

    # ── Consecutive loss circuit breaker ────────────────────────────────────
    "max_consecutive_losses": 3, # Pause agent after this many losses in a row
}

# ── Session state (resets on server restart) ──────────────────────────────────

SESSION = {
    "daily_loss_usd": 0.0,
    "daily_loss_date": str(date.today()),
    "consecutive_losses": 0,
    "agent_paused": False,
    "trades_today": 0,
    "blocked_reason": None,      # Set when kill switch fires
    "opening_balance": None,     # Captured on first trade of the day
}

# ── Trade journal (persists across restarts, survives even manual MT5 trades) ──

JOURNAL_DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "titan_journal.db")


def journal_db():
    conn = sqlite3.connect(JOURNAL_DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_journal_db():
    with closing(journal_db()) as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS trades (
                ticket          INTEGER PRIMARY KEY,
                symbol          TEXT,
                action          TEXT,
                lots            REAL,
                open_price      REAL,
                close_price     REAL,
                sl              REAL,
                tp              REAL,
                opened_at       TEXT,
                closed_at       TEXT,
                profit          REAL,
                status          TEXT,
                source          TEXT,
                confidence      INTEGER,
                technical_bias  TEXT,
                trend           TEXT,
                rsi14           REAL,
                safe_mode       INTEGER,
                comment         TEXT
            )
        """)
        conn.commit()


def journal_record_open(ticket, symbol, action, lots, open_price, sl, tp,
                         source="manual", confidence=None, technical_bias=None,
                         trend=None, rsi14=None, comment=None):
    with closing(journal_db()) as conn:
        conn.execute("""
            INSERT OR IGNORE INTO trades
                (ticket, symbol, action, lots, open_price, sl, tp, opened_at,
                 status, source, confidence, technical_bias, trend, rsi14, safe_mode, comment)
            VALUES (?,?,?,?,?,?,?,?, 'open', ?,?,?,?,?,?,?)
        """, (ticket, symbol, action, lots, open_price, sl, tp, datetime.now().isoformat(),
              source, confidence, technical_bias, trend, rsi14, int(RISK_CONFIG["safe_mode"]), comment))
        conn.commit()


def journal_record_close(ticket, close_price, profit):
    with closing(journal_db()) as conn:
        cur = conn.execute("""
            UPDATE trades SET close_price=?, closed_at=?, profit=?, status='closed'
            WHERE ticket=?
        """, (close_price, datetime.now().isoformat(), profit, ticket))
        conn.commit()
        return cur.rowcount > 0


def journal_sync_from_history():
    """Backfill closed trades placed outside the bridge (e.g. manually in MT5)."""
    try:
        deals = mt5.history_deals_get(datetime(2020, 1, 1), datetime.now())
    except Exception:
        return
    if not deals:
        return
    with closing(journal_db()) as conn:
        for d in deals:
            if d.symbol not in WATCHED_SYMBOLS or d.entry != mt5.DEAL_ENTRY_OUT:
                continue
            existing = conn.execute("SELECT ticket FROM trades WHERE ticket=?", (d.position_id,)).fetchone()
            if existing:
                continue
            action = "BUY" if d.type == mt5.DEAL_TYPE_SELL else "SELL"  # closing deal is opposite side
            conn.execute("""
                INSERT OR IGNORE INTO trades
                    (ticket, symbol, action, lots, close_price, closed_at, profit, status, source, comment)
                VALUES (?,?,?,?,?,?,?, 'closed', 'external', ?)
            """, (d.position_id, d.symbol, action, d.volume, d.price,
                  datetime.fromtimestamp(d.time).isoformat(), d.profit, d.comment))
        conn.commit()


def journal_get_entries(limit=200):
    with closing(journal_db()) as conn:
        rows = conn.execute("""
            SELECT * FROM trades ORDER BY COALESCE(closed_at, opened_at) DESC LIMIT ?
        """, (limit,)).fetchall()
        return [dict(r) for r in rows]


def journal_get_stats():
    with closing(journal_db()) as conn:
        rows = conn.execute("""
            SELECT profit, closed_at FROM trades WHERE status='closed' ORDER BY closed_at ASC
        """).fetchall()
    closed = [dict(r) for r in rows]
    total = len(closed)
    wins   = [t["profit"] for t in closed if t["profit"] and t["profit"] > 0]
    losses = [t["profit"] for t in closed if t["profit"] and t["profit"] < 0]
    total_profit = sum(t["profit"] or 0 for t in closed)
    gross_win  = sum(wins)
    gross_loss = abs(sum(losses))
    equity = 0.0
    equity_curve = []
    for t in closed:
        equity += t["profit"] or 0
        equity_curve.append(round(equity, 2))
    return {
        "total_trades":   total,
        "wins":           len(wins),
        "losses":         len(losses),
        "win_rate_pct":   round(len(wins) / total * 100, 1) if total else 0,
        "total_profit":   round(total_profit, 2),
        "avg_win":        round(sum(wins) / len(wins), 2) if wins else 0,
        "avg_loss":       round(sum(losses) / len(losses), 2) if losses else 0,
        "expectancy":     round(total_profit / total, 2) if total else 0,
        "profit_factor":  round(gross_win / gross_loss, 2) if gross_loss else (gross_win if gross_win else 0),
        "best_trade":     round(max((t["profit"] or 0 for t in closed), default=0), 2),
        "worst_trade":    round(min((t["profit"] or 0 for t in closed), default=0), 2),
        "equity_curve":   equity_curve,
    }

# ── MT5 Lifespan ──────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    init_journal_db()
    print("🔌 Connecting to MT5...")
    if not mt5.initialize(login=MT5_LOGIN, password=MT5_PASSWORD, server=MT5_SERVER):
        print(f"⚠  MT5 init failed: {mt5.last_error()} — running in mock/demo mode")
    else:
        info = mt5.account_info()
        SESSION["opening_balance"] = info.balance
        print(f"✅ MT5 connected | Account: {info.login} | Balance: {info.currency} {info.balance:,.2f}")
        print(f"🛡  Safe Mode: {'ON — fixed 0.01 lots' if RISK_CONFIG['safe_mode'] else 'OFF — dynamic sizing'}")
        try:
            journal_sync_from_history()
            print("📓 Trade journal synced with MT5 history")
        except Exception as e:
            print(f"⚠  Journal sync failed: {e}")
    yield
    mt5.shutdown()
    print("🔌 MT5 disconnected")

app = FastAPI(title="TITAN MT5 Bridge", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

ai_client = anthropic.Anthropic(api_key=ANTHROPIC_KEY)

# ── Pydantic models ────────────────────────────────────────────────────────────

class TradeRequest(BaseModel):
    symbol: str
    action: str                  # "BUY" | "SELL"
    lots: Optional[float] = None # If None, resolved by safe_mode / risk_pct
    sl: Optional[float] = None
    tp: Optional[float] = None
    comment: str = "TITAN-AI"
    # Journal metadata — set by the agent (auto-execute or Execute button) so
    # the journal can record why the trade was taken. Absent for manual trades.
    source: str = "manual"
    confidence: Optional[int] = None
    technical_bias: Optional[str] = None
    trend: Optional[str] = None
    rsi14: Optional[float] = None

class ConfigUpdate(BaseModel):
    safe_mode: Optional[bool] = None
    fixed_lots: Optional[float] = None
    risk_pct: Optional[float] = None
    sl_pips: Optional[int] = None
    tp_ratio: Optional[float] = None
    min_confidence: Optional[int] = None
    max_positions: Optional[int] = None
    max_daily_loss_pct: Optional[float] = None
    max_loss_per_trade_usd: Optional[float] = None
    max_consecutive_losses: Optional[int] = None

# ── Session helpers ────────────────────────────────────────────────────────────

def reset_daily_session_if_new_day():
    today = str(date.today())
    if SESSION["daily_loss_date"] != today:
        SESSION["daily_loss_usd"] = 0.0
        SESSION["daily_loss_date"] = today
        SESSION["trades_today"] = 0
        SESSION["blocked_reason"] = None
        SESSION["agent_paused"] = False
        SESSION["consecutive_losses"] = 0
        account = get_account()
        SESSION["opening_balance"] = account.get("balance", 0)
        print(f"📅 New trading day — session reset. Opening balance: {SESSION['opening_balance']}")


def check_kill_switches(balance: float) -> tuple[bool, str | None]:
    """
    Returns (blocked: bool, reason: str | None).
    Call before every trade attempt.
    """
    reset_daily_session_if_new_day()

    # 1. Daily loss kill switch
    if SESSION["opening_balance"] and SESSION["opening_balance"] > 0:
        loss_pct = (SESSION["daily_loss_usd"] / SESSION["opening_balance"]) * 100
        if loss_pct >= RISK_CONFIG["max_daily_loss_pct"]:
            reason = (
                f"🚨 Daily loss limit hit: -{loss_pct:.1f}% "
                f"(limit {RISK_CONFIG['max_daily_loss_pct']}%). "
                "No new trades until tomorrow."
            )
            SESSION["blocked_reason"] = reason
            return True, reason

    # 2. Consecutive loss circuit breaker
    if SESSION["consecutive_losses"] >= RISK_CONFIG["max_consecutive_losses"]:
        reason = (
            f"⚠ {SESSION['consecutive_losses']} consecutive losses. "
            "Agent paused — review conditions or reset manually via POST /reset-losses."
        )
        SESSION["agent_paused"] = True
        SESSION["blocked_reason"] = reason
        return True, reason

    # 3. Max positions
    open_pos = get_open_positions()
    if len(open_pos) >= RISK_CONFIG["max_positions"]:
        return True, f"Max positions ({RISK_CONFIG['max_positions']}) already open."

    return False, None


def calculate_pnl_usd(symbol: str, lots: float, price_diff: float) -> float:
    """Estimate dollar P&L for a given price distance and lot size."""
    info = mt5.symbol_info(symbol)
    if info is None or price_diff <= 0:
        return 0.0
    pips = price_diff / info.point / 10
    pip_value = info.trade_tick_value * (info.point / info.trade_tick_size) if info.trade_tick_size else 0
    return pips * pip_value * lots * 10


def estimate_sl_risk_usd(symbol: str, action: str, lots: float, sl: float, entry: float) -> float:
    """Estimate the dollar risk if SL is hit."""
    if sl == 0:
        return 0.0
    return calculate_pnl_usd(symbol, lots, abs(entry - sl))


def record_trade_result(profit: float):
    """Called after a trade closes to track daily loss and consecutive losses."""
    reset_daily_session_if_new_day()
    if profit < 0:
        SESSION["daily_loss_usd"] += abs(profit)
        SESSION["consecutive_losses"] += 1
    else:
        SESSION["consecutive_losses"] = 0  # Reset streak on any win
    SESSION["trades_today"] += 1

# ── MT5 helpers ───────────────────────────────────────────────────────────────

def get_account() -> dict:
    info = mt5.account_info()
    if info is None:
        return {"balance": 0, "equity": 0, "margin_free": 0, "currency": "USD", "login": 0}
    return {
        "balance": info.balance,
        "equity": info.equity,
        "margin_free": info.margin_free,
        "profit": info.profit,
        "currency": info.currency,
        "login": info.login,
        "leverage": info.leverage,
    }


def get_prices(symbols: list[str]) -> dict:
    result = {}
    for sym in symbols:
        info = mt5.symbol_info(sym)
        if info is None:
            continue
        if not info.visible:
            mt5.symbol_select(sym, True)
        tick = mt5.symbol_info_tick(sym)
        if tick:
            result[sym] = {
                "bid": tick.bid,
                "ask": tick.ask,
                "time": datetime.fromtimestamp(tick.time).isoformat(),
            }
    return result


# ── Technical analysis (trend / momentum / historical context) ────────────────

def _sma(values: list[float], period: int) -> Optional[float]:
    if len(values) < period:
        return None
    return sum(values[-period:]) / period


def _rsi(values: list[float], period: int = 14) -> Optional[float]:
    """Classic RSI using a simple (non-Wilder) average — good enough for a bias read."""
    if len(values) < period + 1:
        return None
    gains, losses = [], []
    for i in range(1, len(values)):
        diff = values[i] - values[i - 1]
        gains.append(max(diff, 0))
        losses.append(max(-diff, 0))
    avg_gain = sum(gains[-period:]) / period
    avg_loss = sum(losses[-period:]) / period
    if avg_loss == 0:
        return 100.0
    rs = avg_gain / avg_loss
    return 100 - (100 / (1 + rs))


def get_technical_snapshot(symbol: str, timeframe=mt5.TIMEFRAME_H1, bars: int = 100) -> Optional[dict]:
    """
    Pull recent candle history from MT5 and derive a compact trend/momentum
    read: SMA20 vs SMA50 trend, RSI14, recent swing range, and a deterministic
    technical bias the AI can weigh alongside its own reasoning.
    """
    rates = mt5.copy_rates_from_pos(symbol, timeframe, 0, bars)
    if rates is None or len(rates) < 30:
        return None

    closes = [float(r["close"]) for r in rates]
    highs  = [float(r["high"]) for r in rates]
    lows   = [float(r["low"]) for r in rates]
    last   = closes[-1]

    sma20, sma50 = _sma(closes, 20), _sma(closes, 50)
    rsi14 = _rsi(closes, 14)
    swing_high, swing_low = max(highs[-50:]), min(lows[-50:])
    change_pct = ((last - closes[-25]) / closes[-25] * 100) if len(closes) >= 25 else None

    trend = None
    if sma20 is not None and sma50 is not None:
        trend = "up" if sma20 > sma50 else "down" if sma20 < sma50 else "flat"

    rsi_signal = None
    if rsi14 is not None:
        rsi_signal = "overbought" if rsi14 >= 70 else "oversold" if rsi14 <= 30 else "neutral"

    # Deterministic bias: trend + price position vs SMA20 + RSI extremes.
    score = 0
    if trend == "up": score += 1
    elif trend == "down": score -= 1
    if sma20 is not None:
        score += 1 if last > sma20 else -1
    if rsi_signal == "oversold": score += 1
    elif rsi_signal == "overbought": score -= 1
    bias = "BULLISH" if score >= 2 else "BEARISH" if score <= -2 else "NEUTRAL"

    return {
        "trend": trend,
        "sma20": round(sma20, 5) if sma20 is not None else None,
        "sma50": round(sma50, 5) if sma50 is not None else None,
        "rsi14": round(rsi14, 1) if rsi14 is not None else None,
        "rsi_signal": rsi_signal,
        "swing_high": round(swing_high, 5),
        "swing_low": round(swing_low, 5),
        "change_24h_pct": round(change_pct, 2) if change_pct is not None else None,
        "bias": bias,
    }


def get_technicals(symbols: list[str]) -> dict:
    result = {}
    for sym in symbols:
        snap = get_technical_snapshot(sym)
        if snap:
            result[sym] = snap
    return result


def get_open_positions() -> list[dict]:
    positions = mt5.positions_get()
    if positions is None:
        return []
    return [
        {
            "ticket": p.ticket,
            "symbol": p.symbol,
            "type": "BUY" if p.type == mt5.ORDER_TYPE_BUY else "SELL",
            "lots": p.volume,
            "open_price": p.price_open,
            "sl": p.sl,
            "tp": p.tp,
            "profit": p.profit,
            "time": datetime.fromtimestamp(p.time).isoformat(),
            "comment": p.comment,
        }
        for p in positions
    ]


def calculate_lot_size(symbol: str, sl_pips: float, risk_pct: float, balance: float) -> float:
    """Dynamic lot sizing — only used when safe_mode is OFF."""
    risk_amount = balance * (risk_pct / 100)
    info = mt5.symbol_info(symbol)
    if info is None:
        return 0.01
    pip_value = info.trade_tick_value * (info.point / info.trade_tick_size) if info.trade_tick_size else 0
    if pip_value == 0:
        return 0.01
    raw_lots = risk_amount / (sl_pips * pip_value)
    step = info.volume_step
    lots = round(raw_lots / step) * step
    lots = max(info.volume_min, min(info.volume_max, lots))
    return round(lots, 2)


def resolve_lots(symbol: str, balance: float) -> float:
    """
    Returns the lot size to use.
    Safe mode always wins — returns fixed_lots regardless of anything else.
    """
    if RISK_CONFIG["safe_mode"]:
        return RISK_CONFIG["fixed_lots"]   # Hard lock: 0.01
    return calculate_lot_size(
        symbol,
        RISK_CONFIG["sl_pips"],
        RISK_CONFIG["risk_pct"],
        balance,
    )

# ── Core trade execution ──────────────────────────────────────────────────────

def execute_trade(req: TradeRequest) -> dict:
    account = get_account()
    balance = account["balance"]

    # ── Kill switch check ──────────────────────────────────────────────────
    blocked, reason = check_kill_switches(balance)
    if blocked:
        raise HTTPException(403, reason)

    sym_info = mt5.symbol_info(req.symbol)
    if sym_info is None:
        raise HTTPException(400, f"Symbol {req.symbol} not found in MT5")
    if not sym_info.visible:
        mt5.symbol_select(req.symbol, True)

    tick = mt5.symbol_info_tick(req.symbol)
    order_type = mt5.ORDER_TYPE_BUY if req.action == "BUY" else mt5.ORDER_TYPE_SELL
    price = tick.ask if req.action == "BUY" else tick.bid

    # ── Resolve lot size — safe mode overrides everything ──────────────────
    lots = resolve_lots(req.symbol, balance)
    # If a specific lot was manually requested and safe mode is OFF, honour it
    if req.lots is not None and not RISK_CONFIG["safe_mode"]:
        lots = req.lots

    # ── Build SL / TP ──────────────────────────────────────────────────────
    sl, tp = req.sl, req.tp
    if sl is None or tp is None:
        point = sym_info.point
        pips = RISK_CONFIG["sl_pips"] * point * 10
        if req.action == "BUY":
            sl = sl or round(price - pips, sym_info.digits)
            tp = tp or round(price + pips * RISK_CONFIG["tp_ratio"], sym_info.digits)
        else:
            sl = sl or round(price + pips, sym_info.digits)
            tp = tp or round(price - pips * RISK_CONFIG["tp_ratio"], sym_info.digits)

    # ── Max loss per trade guardrail ───────────────────────────────────────
    sl_risk_usd = estimate_sl_risk_usd(req.symbol, req.action, lots, sl, price)
    if sl_risk_usd > RISK_CONFIG["max_loss_per_trade_usd"] and sl_risk_usd > 0:
        raise HTTPException(
            403,
            f"Trade rejected: SL risk ${sl_risk_usd:.2f} exceeds "
            f"max_loss_per_trade_usd ${RISK_CONFIG['max_loss_per_trade_usd']:.2f}. "
            "Widen your SL or reduce lot size."
        )

    # ── Send order ─────────────────────────────────────────────────────────
    request = {
        "action": mt5.TRADE_ACTION_DEAL,
        "symbol": req.symbol,
        "volume": lots,
        "type": order_type,
        "price": price,
        "sl": sl,
        "tp": tp,
        "deviation": 20,
        "magic": 20250606,
        "comment": req.comment,
        "type_time": mt5.ORDER_TIME_GTC,
        "type_filling": mt5.ORDER_FILLING_IOC,
    }

    result = mt5.order_send(request)
    if result.retcode != mt5.TRADE_RETCODE_DONE:
        raise HTTPException(400, f"Order failed: {result.comment} (code {result.retcode})")

    SESSION["trades_today"] += 1

    try:
        journal_record_open(
            ticket=result.order, symbol=req.symbol, action=req.action, lots=lots,
            open_price=result.price, sl=sl, tp=tp,
            source=req.source, confidence=req.confidence, technical_bias=req.technical_bias,
            trend=req.trend, rsi14=req.rsi14, comment=req.comment,
        )
    except Exception as e:
        print(f"⚠  Journal write (open) failed: {e}")

    return {
        "ticket": result.order,
        "symbol": req.symbol,
        "action": req.action,
        "lots": lots,
        "price": result.price,
        "sl": sl,
        "tp": tp,
        "sl_risk_usd": round(sl_risk_usd, 2),
        "safe_mode": RISK_CONFIG["safe_mode"],
        "timestamp": datetime.now().isoformat(),
    }


def close_position(ticket: int) -> dict:
    position = None
    for p in (mt5.positions_get() or []):
        if p.ticket == ticket:
            position = p
            break
    if position is None:
        raise HTTPException(404, f"Position {ticket} not found")

    tick = mt5.symbol_info_tick(position.symbol)
    close_type = mt5.ORDER_TYPE_SELL if position.type == mt5.ORDER_TYPE_BUY else mt5.ORDER_TYPE_BUY
    close_price = tick.bid if close_type == mt5.ORDER_TYPE_SELL else tick.ask

    request = {
        "action": mt5.TRADE_ACTION_DEAL,
        "symbol": position.symbol,
        "volume": position.volume,
        "type": close_type,
        "position": ticket,
        "price": close_price,
        "deviation": 20,
        "magic": 20250606,
        "comment": "TITAN-CLOSE",
        "type_time": mt5.ORDER_TIME_GTC,
        "type_filling": mt5.ORDER_FILLING_IOC,
    }

    result = mt5.order_send(request)
    if result.retcode != mt5.TRADE_RETCODE_DONE:
        raise HTTPException(400, f"Close failed: {result.comment}")

    record_trade_result(position.profit)

    try:
        if not journal_record_close(ticket, close_price, position.profit):
            # Position wasn't tracked (opened outside the bridge) — backfill a closed row.
            action = "BUY" if position.type == mt5.ORDER_TYPE_BUY else "SELL"
            with closing(journal_db()) as conn:
                conn.execute("""
                    INSERT OR IGNORE INTO trades
                        (ticket, symbol, action, lots, open_price, close_price, sl, tp,
                         opened_at, closed_at, profit, status, source, comment)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?, 'closed', 'external', ?)
                """, (ticket, position.symbol, action, position.volume, position.price_open,
                      close_price, position.sl, position.tp,
                      datetime.fromtimestamp(position.time).isoformat(), datetime.now().isoformat(),
                      position.profit, position.comment))
                conn.commit()
    except Exception as e:
        print(f"⚠  Journal write (close) failed: {e}")

    return {
        "closed_ticket": ticket,
        "profit": position.profit,
        "daily_loss_usd": SESSION["daily_loss_usd"],
        "consecutive_losses": SESSION["consecutive_losses"],
        "timestamp": datetime.now().isoformat(),
    }

# ── AI Analysis ────────────────────────────────────────────────────────────────

async def run_ai_analysis(auto_execute: bool = False) -> dict:
    reset_daily_session_if_new_day()

    account = get_account()
    prices  = get_prices(WATCHED_SYMBOLS)
    open_pos = get_open_positions()
    technicals = get_technicals(WATCHED_SYMBOLS)

    price_lines = "\n".join(
        f"{sym}: bid={d['bid']} ask={d['ask']}" for sym, d in prices.items()
    )

    tech_lines = "\n".join(
        f"{sym}: trend={t['trend']} (SMA20 {t['sma20']} vs SMA50 {t['sma50']}), "
        f"RSI14={t['rsi14']} ({t['rsi_signal']}), 24h change={t['change_24h_pct']}%, "
        f"recent swing range {t['swing_low']}–{t['swing_high']}, technical bias={t['bias']}"
        for sym, t in technicals.items()
    ) or "No technical history available."

    safe_note = (
        "SAFE MODE ACTIVE — all trades will use 0.01 lots regardless of suggestion."
        if RISK_CONFIG["safe_mode"] else
        f"Dynamic sizing active — risk {RISK_CONFIG['risk_pct']}% per trade."
    )

    prompt = f"""You are an expert algorithmic trader specialising in Forex and Commodities.
Analyse the current market and decide whether to execute trades.

MARKET DATA ({datetime.now().strftime('%H:%M:%S')}):
{price_lines}

TECHNICAL CONTEXT (H1 candles, last 100 bars):
{tech_lines}

Use the trend, RSI momentum, and recent swing range above to confirm directional
bias before suggesting BUY or SELL — do not trade against a clear trend/technical
bias unless RSI shows a genuine reversal setup (oversold in an uptrend pullback,
overbought in a downtrend rally). If technical bias is NEUTRAL or conflicts with
the trend, prefer HOLD unless price action strongly justifies otherwise.

ACCOUNT:
- Balance: {account['currency']} {account['balance']:,.2f}
- Equity: {account['currency']} {account['equity']:,.2f}
- Open positions: {len(open_pos)} / {RISK_CONFIG['max_positions']} max
- Daily loss so far: ${SESSION['daily_loss_usd']:.2f} (limit: {RISK_CONFIG['max_daily_loss_pct']}% of balance)
- Consecutive losses: {SESSION['consecutive_losses']} (pause after {RISK_CONFIG['max_consecutive_losses']})

OPEN POSITIONS:
{json.dumps(open_pos, indent=2) if open_pos else 'None'}

RISK PARAMETERS:
- {safe_note}
- SL buffer: {RISK_CONFIG['sl_pips']} pips
- TP ratio: {RISK_CONFIG['tp_ratio']}:1 R:R
- Min confidence to auto-execute: {RISK_CONFIG['min_confidence']}%
- Max loss per trade: ${RISK_CONFIG['max_loss_per_trade_usd']:.2f}

Use the exact symbol names as given in MARKET DATA above (including any broker suffix) — do not shorten or rewrite them.

Respond ONLY in JSON, no markdown, no preamble:
{{
  "summary": "2-sentence market overview",
  "signals": [
    {{
      "symbol": "{WATCHED_SYMBOLS[0]}",
      "action": "BUY|SELL|HOLD",
      "confidence": 0-100,
      "rationale": "concise reason based on price action",
      "suggestedLots": 0.01,
      "estimatedSL": 0.0,
      "estimatedTP": 0.0
    }}
  ],
  "riskWarning": "notable risk factor or null",
  "overallSentiment": "BULLISH|BEARISH|NEUTRAL"
}}"""

    try:
        message = ai_client.messages.create(
            model="claude-sonnet-5",
            max_tokens=2000,
            messages=[{"role": "user", "content": prompt}],
        )
    except anthropic.APIError as e:
        raise HTTPException(502, f"Anthropic API error: {e}")

    raw = next((b.text for b in message.content if b.type == "text"), "")
    clean = raw.replace("```json", "").replace("```", "").strip()
    try:
        analysis = json.loads(clean)
    except json.JSONDecodeError as e:
        raise HTTPException(502, f"AI returned non-JSON response: {e}. Raw: {raw[:300]}")
    analysis["timestamp"]        = datetime.now().isoformat()
    analysis["account_snapshot"] = account
    analysis["technicals"]       = technicals
    analysis["session"]          = {
        "safe_mode":           RISK_CONFIG["safe_mode"],
        "daily_loss_usd":      SESSION["daily_loss_usd"],
        "consecutive_losses":  SESSION["consecutive_losses"],
        "trades_today":        SESSION["trades_today"],
        "blocked_reason":      SESSION["blocked_reason"],
    }

    # ── Estimate potential $ / R gain-loss per signal, attach technical bias ─
    usdzar_rate = prices.get("USDZARm", {}).get("bid")
    for sig in analysis.get("signals", []):
        tech = technicals.get(sig.get("symbol"))
        if tech:
            sig["technicalBias"] = tech["bias"]
            sig["trend"] = tech["trend"]
            sig["rsi14"] = tech["rsi14"]
        if sig.get("action") == "HOLD":
            continue
        tick = prices.get(sig.get("symbol"))
        sl, tp = sig.get("estimatedSL") or 0, sig.get("estimatedTP") or 0
        lots = sig.get("suggestedLots") or RISK_CONFIG["fixed_lots"]
        if not tick or not sl or not tp:
            continue
        entry = tick["ask"] if sig["action"] == "BUY" else tick["bid"]
        gain_usd = calculate_pnl_usd(sig["symbol"], lots, abs(tp - entry))
        loss_usd = calculate_pnl_usd(sig["symbol"], lots, abs(entry - sl))
        sig["potentialGainUsd"] = round(gain_usd, 2)
        sig["potentialLossUsd"] = round(loss_usd, 2)
        if usdzar_rate:
            sig["potentialGainZar"] = round(gain_usd * usdzar_rate, 2)
            sig["potentialLossZar"] = round(loss_usd * usdzar_rate, 2)

    # Auto-execute high-confidence signals
    if auto_execute:
        blocked, block_reason = check_kill_switches(account["balance"])
        if blocked:
            analysis["auto_execute_blocked"] = block_reason
        else:
            for sig in analysis.get("signals", []):
                if sig["action"] != "HOLD" and sig["confidence"] >= RISK_CONFIG["min_confidence"]:
                    req = TradeRequest(
                        symbol=sig["symbol"],
                        action=sig["action"],
                        lots=None,   # resolved internally by resolve_lots()
                        sl=sig.get("estimatedSL") or None,
                        tp=sig.get("estimatedTP") or None,
                        comment=f"TITAN-AI-{sig['confidence']}%",
                        source="agent",
                        confidence=sig.get("confidence"),
                        technical_bias=sig.get("technicalBias"),
                        trend=sig.get("trend"),
                        rsi14=sig.get("rsi14"),
                    )
                    try:
                        trade_result  = execute_trade(req)
                        sig["executed"] = True
                        sig["trade"]    = trade_result
                    except HTTPException as e:
                        sig["executed"] = False
                        sig["error"]    = e.detail
                    except Exception as e:
                        sig["executed"] = False
                        sig["error"]    = str(e)

    return analysis

# ── Routes ─────────────────────────────────────────────────────────────────────

@app.get("/")
def root():
    return {
        "service":   "TITAN MT5 Bridge",
        "version":   "2.0.0",
        "safe_mode": RISK_CONFIG["safe_mode"],
        "status":    "blocked" if SESSION["blocked_reason"] else "running",
        "blocked_reason": SESSION["blocked_reason"],
    }

@app.get("/account")
def account_info():
    return get_account()

@app.get("/prices")
def prices():
    return get_prices(WATCHED_SYMBOLS)

@app.get("/positions")
def positions():
    return get_open_positions()

@app.post("/trade")
def trade(req: TradeRequest):
    """Manually place a trade. All guardrails still apply."""
    return execute_trade(req)

@app.delete("/position/{ticket}")
def close(ticket: int):
    """Close a specific position by MT5 ticket number."""
    return close_position(ticket)

@app.post("/analyse")
async def analyse(auto_execute: bool = False):
    """
    AI market analysis.
    ?auto_execute=true — agent places trades if confidence >= min_confidence
                         and all kill switches are clear.
    """
    try:
        return await run_ai_analysis(auto_execute=auto_execute)
    except HTTPException:
        raise
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(500, f"{type(e).__name__}: {e}")

@app.get("/config")
def get_config():
    return {"config": RISK_CONFIG, "session": SESSION}

@app.put("/config")
def update_config(update: ConfigUpdate):
    """
    Update risk parameters at runtime.
    safe_mode=true/false is the master switch for lot sizing.
    """
    for k, v in update.dict(exclude_none=True).items():
        RISK_CONFIG[k] = v
    print(f"⚙  Config updated: {update.dict(exclude_none=True)}")
    return {"updated": True, "config": RISK_CONFIG}

@app.get("/session")
def session_status():
    """Live session stats: daily loss, kill switch state, consecutive losses."""
    reset_daily_session_if_new_day()
    account = get_account()
    balance = account.get("balance", 0) or SESSION.get("opening_balance", 1)
    opening = SESSION["opening_balance"] or balance
    daily_loss_pct = (SESSION["daily_loss_usd"] / opening * 100) if opening else 0
    return {
        **SESSION,
        "daily_loss_pct":       round(daily_loss_pct, 2),
        "daily_loss_limit_pct": RISK_CONFIG["max_daily_loss_pct"],
        "kill_switch_active":   daily_loss_pct >= RISK_CONFIG["max_daily_loss_pct"],
        "safe_mode":            RISK_CONFIG["safe_mode"],
        "fixed_lots":           RISK_CONFIG["fixed_lots"],
    }

@app.post("/reset-losses")
def reset_consecutive_losses():
    """
    Manually clear the consecutive-loss pause.
    Use after reviewing why losses occurred.
    """
    SESSION["consecutive_losses"] = 0
    SESSION["agent_paused"]       = False
    SESSION["blocked_reason"]     = None
    return {"reset": True, "message": "Consecutive loss counter cleared. Agent unpaused."}

@app.get("/history")
def trade_history(limit: int = 50):
    deals = mt5.history_deals_get(datetime(2020, 1, 1), datetime.now())
    if deals is None:
        return []
    return [
        {
            "ticket": d.ticket,
            "symbol": d.symbol,
            "type":   "BUY" if d.type == mt5.DEAL_TYPE_BUY else "SELL",
            "lots":   d.volume,
            "price":  d.price,
            "profit": d.profit,
            "time":   datetime.fromtimestamp(d.time).isoformat(),
            "comment": d.comment,
        }
        for d in sorted(deals, key=lambda x: x.time, reverse=True)[:limit]
        if d.symbol in WATCHED_SYMBOLS
    ]

@app.get("/journal")
def journal(limit: int = 200):
    """
    Persistent trade journal — every trade opened/closed through this bridge,
    plus any closed externally (e.g. manually in the MT5 terminal), backfilled
    from MT5 history on startup.
    """
    return journal_get_entries(limit=limit)

@app.get("/journal/stats")
def journal_stats():
    """Win rate, expectancy, profit factor, and an equity curve over closed trades."""
    return journal_get_stats()

@app.post("/journal/sync")
def journal_sync():
    """Manually re-sync the journal against MT5 history (also runs on startup)."""
    journal_sync_from_history()
    return {"synced": True}

# ── Entry point ────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("mt5_bridge:app", host="0.0.0.0", port=8000, reload=False)
