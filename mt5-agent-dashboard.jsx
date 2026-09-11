import { useState, useEffect, useRef, useCallback } from "react";

const SYMBOLS = ["XAUUSD", "EURUSD", "USDZAR", "XAGUSD", "USOIL"];

const MOCK_PRICES = {
  XAUUSD: { bid: 3318.45, ask: 3318.85, change: +0.42 },
  EURUSD: { bid: 1.08432, ask: 1.08438, change: -0.11 },
  USDZAR: { bid: 18.3421, ask: 18.3489, change: +0.23 },
  XAGUSD: { bid: 32.841,  ask: 32.869,  change: +1.02 },
  USOIL:  { bid: 78.21,   ask: 78.35,   change: -0.38 },
};

const INITIAL_TRADES = [
  { id: 1, symbol: "XAUUSD", type: "BUY",  lots: 0.01, openPrice: 3301.20, sl: 3285.00, tp: 3340.00, profit: +17.25, time: "08:14:03", status: "open" },
  { id: 2, symbol: "EURUSD", type: "SELL", lots: 0.01, openPrice: 1.08510, sl: 1.08750, tp: 1.08200, profit: -1.56,  time: "09:02:47", status: "open" },
  { id: 3, symbol: "USDZAR", type: "BUY",  lots: 0.01, openPrice: 18.2900, sl: 18.1500, tp: 18.5000, profit: +5.22,  time: "10:31:11", status: "open" },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function Spark({ positive }) {
  const pts = positive
    ? [10,38,22,30,18,25,30,18,38,12,50,8,60,15,70,10,80,5]
    : [10,12,22,18,30,28,38,22,50,30,60,38,70,35,80,42];
  const poly = pts.reduce((a, v, i) => a + (i % 2 === 0 ? `${v},` : `${v} `), "");
  return (
    <svg width="90" height="50" viewBox="0 0 90 50" style={{ opacity: 0.7 }}>
      <polyline points={poly} fill="none" stroke={positive ? "#00e5a0" : "#ff4d6d"} strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

function Toggle({ value, onChange, label, sublabel, danger }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 0", borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
      <div>
        <div style={{ fontFamily: "'Syne', sans-serif", fontWeight: 600, fontSize: 14, color: danger && value ? "#ff4d6d" : "#fff" }}>{label}</div>
        {sublabel && <div style={{ fontSize: 12, color: "#555", marginTop: 3 }}>{sublabel}</div>}
      </div>
      <div
        onClick={() => onChange(!value)}
        style={{
          width: 48, height: 26, borderRadius: 13,
          background: value ? (danger ? "#ff4d6d" : "#00e5a0") : "#222",
          cursor: "pointer", position: "relative", transition: "background 0.25s", flexShrink: 0,
        }}
      >
        <div style={{ position: "absolute", top: 3, left: value ? 25 : 3, width: 20, height: 20, borderRadius: "50%", background: "#fff", transition: "left 0.25s" }} />
      </div>
    </div>
  );
}

// ── Safe Mode Banner ──────────────────────────────────────────────────────────
function SafeModeBanner({ safeMode, onToggle }) {
  return (
    <div style={{
      background: safeMode ? "rgba(0,229,160,0.07)" : "rgba(255,77,109,0.07)",
      border: `1px solid ${safeMode ? "rgba(0,229,160,0.2)" : "rgba(255,77,109,0.3)"}`,
      borderRadius: 14, padding: "14px 20px",
      display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <div style={{ fontSize: 22 }}>{safeMode ? "🛡" : "⚠️"}</div>
        <div>
          <div style={{ fontFamily: "'Syne', sans-serif", fontWeight: 700, fontSize: 14, color: safeMode ? "#00e5a0" : "#ff4d6d" }}>
            {safeMode ? "Safe Mode ON — 0.01 lots locked" : "Safe Mode OFF — Dynamic lot sizing active"}
          </div>
          <div style={{ fontSize: 12, color: "#666", marginTop: 2 }}>
            {safeMode
              ? "All trades use fixed 0.01 lots regardless of AI suggestion. Recommended for live accounts."
              : "Lot size calculated dynamically from risk %. Use only when comfortable with your strategy."}
          </div>
        </div>
      </div>
      <button
        onClick={() => onToggle(!safeMode)}
        style={{
          background: safeMode ? "rgba(255,77,109,0.1)" : "rgba(0,229,160,0.1)",
          border: `1px solid ${safeMode ? "rgba(255,77,109,0.25)" : "rgba(0,229,160,0.25)"}`,
          borderRadius: 10, padding: "8px 16px", cursor: "pointer", whiteSpace: "nowrap",
          color: safeMode ? "#ff4d6d" : "#00e5a0",
          fontFamily: "'Syne', sans-serif", fontWeight: 700, fontSize: 12,
        }}
      >
        {safeMode ? "Turn Off" : "Turn On"}
      </button>
    </div>
  );
}

// ── Daily Loss Meter ──────────────────────────────────────────────────────────
function DailyLossMeter({ dailyLoss, dailyLossLimit, openingBalance }) {
  const pct = openingBalance > 0 ? Math.min((dailyLoss / openingBalance) * 100, dailyLossLimit) : 0;
  const ratio = pct / dailyLossLimit;
  const color = ratio < 0.5 ? "#00e5a0" : ratio < 0.8 ? "#f5c518" : "#ff4d6d";
  const triggered = pct >= dailyLossLimit;

  return (
    <div style={{ background: "rgba(255,255,255,0.03)", border: `1px solid ${triggered ? "rgba(255,77,109,0.3)" : "rgba(255,255,255,0.07)"}`, borderRadius: 14, padding: "18px 20px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: 11, color: "#555", letterSpacing: "0.12em", textTransform: "uppercase", fontFamily: "'Syne', sans-serif" }}>Daily Loss</div>
          <div style={{ fontSize: 22, fontWeight: 800, color, fontFamily: "'Syne', sans-serif", marginTop: 4 }}>
            ${dailyLoss.toFixed(2)}
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: 11, color: "#444" }}>Limit: {dailyLossLimit}% of balance</div>
          <div style={{ fontSize: 13, color: "#666", marginTop: 2 }}>{pct.toFixed(1)}% used</div>
        </div>
      </div>
      <div style={{ height: 6, background: "rgba(255,255,255,0.06)", borderRadius: 3, overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${Math.min(ratio * 100, 100)}%`, background: color, borderRadius: 3, transition: "width 0.4s, background 0.4s" }} />
      </div>
      {triggered && (
        <div style={{ marginTop: 10, fontSize: 12, color: "#ff4d6d", display: "flex", gap: 6, alignItems: "center" }}>
          <span>🚨</span> Kill switch active — no new trades until tomorrow
        </div>
      )}
    </div>
  );
}

// ── Consecutive Loss Tracker ──────────────────────────────────────────────────
function LossStreak({ consecutive, maxAllowed, onReset }) {
  const isPaused = consecutive >= maxAllowed;
  return (
    <div style={{ background: "rgba(255,255,255,0.03)", border: `1px solid ${isPaused ? "rgba(255,77,109,0.3)" : "rgba(255,255,255,0.07)"}`, borderRadius: 14, padding: "18px 20px" }}>
      <div style={{ fontSize: 11, color: "#555", letterSpacing: "0.12em", textTransform: "uppercase", fontFamily: "'Syne', sans-serif", marginBottom: 12 }}>Loss Streak</div>
      <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
        {Array.from({ length: maxAllowed }).map((_, i) => (
          <div key={i} style={{
            flex: 1, height: 8, borderRadius: 4,
            background: i < consecutive ? "#ff4d6d" : "rgba(255,255,255,0.06)",
            transition: "background 0.3s",
          }} />
        ))}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ fontSize: 13, color: isPaused ? "#ff4d6d" : "#666" }}>
          {isPaused ? "⚠ Agent paused after 3 losses" : `${consecutive} / ${maxAllowed} losses`}
        </div>
        {isPaused && (
          <button onClick={onReset} style={{
            background: "rgba(0,229,160,0.1)", border: "1px solid rgba(0,229,160,0.2)",
            borderRadius: 8, padding: "5px 12px", color: "#00e5a0", cursor: "pointer",
            fontFamily: "'Syne', sans-serif", fontWeight: 600, fontSize: 11,
          }}>Reset</button>
        )}
      </div>
    </div>
  );
}

// ── Agent Panel ───────────────────────────────────────────────────────────────
function AgentPanel({ config, onTrade, killSwitchActive, agentPaused }) {
  const [thinking, setThinking] = useState(false);
  const [analysis, setAnalysis]  = useState(null);
  const [error, setError]        = useState(null);

  const blocked = killSwitchActive || agentPaused;

  const runAnalysis = useCallback(async () => {
    if (thinking || blocked) return;
    setThinking(true);
    setAnalysis(null);
    setError(null);

    const prices = Object.entries(MOCK_PRICES)
      .map(([sym, d]) => `${sym}: bid=${d.bid} ask=${d.ask} 24h_change=${d.change}%`)
      .join("\n");

    const safeLine = config.safeMode
      ? "SAFE MODE ACTIVE — all trades will use 0.01 lots."
      : `Dynamic sizing — risk ${config.riskPct}% per trade.`;

    const prompt = `You are an expert algorithmic trader. Analyse the market snapshot and decide on trades.

MARKET DATA (${new Date().toLocaleTimeString()}):
${prices}

RISK PARAMETERS:
- ${safeLine}
- Max risk per trade: ${config.riskPct}% of $${config.balance.toLocaleString()}
- Max simultaneous positions: ${config.maxPositions}
- Current open positions: ${config.openPositions}
- Stop-loss buffer: ${config.slPips} pips
- Take-profit ratio: ${config.tpRatio}:1 R:R
- Min confidence to execute: ${config.minConfidence}%
- Max daily loss limit: ${config.maxDailyLossPct}%
- Max loss per trade: $${config.maxLossPerTrade}
- Daily loss so far: $${config.dailyLoss.toFixed(2)}
- Consecutive losses: ${config.consecutiveLosses}

FOCUS: Forex (EURUSD, USDZAR) and Commodities (XAUUSD, XAGUSD, USOIL)

Respond ONLY in JSON, no markdown:
{
  "summary": "2-sentence market overview",
  "signals": [
    {
      "symbol": "XAUUSD",
      "action": "BUY|SELL|HOLD",
      "confidence": 0-100,
      "rationale": "concise price-action reason",
      "suggestedLots": 0.01,
      "estimatedSL": 0.0,
      "estimatedTP": 0.0
    }
  ],
  "riskWarning": "notable risk or null",
  "overallSentiment": "BULLISH|BEARISH|NEUTRAL"
}`;

    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-5",
          max_tokens: 1000,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      const data  = await res.json();
      const raw   = data.content?.find(b => b.type === "text")?.text || "";
      const clean = raw.replace(/```json|```/g, "").trim();
      setAnalysis(JSON.parse(clean));
    } catch (e) {
      setError("Agent error: " + e.message);
    } finally {
      setThinking(false);
    }
  }, [thinking, blocked, config]);

  const sentColor = { BULLISH: "#00e5a0", BEARISH: "#ff4d6d", NEUTRAL: "#f5c518" };

  return (
    <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 16, padding: 24, display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <div style={{ fontFamily: "'Syne', sans-serif", fontSize: 13, color: "#888", letterSpacing: "0.12em", textTransform: "uppercase" }}>AI Agent</div>
          <div style={{ fontFamily: "'Syne', sans-serif", fontSize: 18, fontWeight: 700, color: "#fff", marginTop: 2 }}>Market Analysis</div>
        </div>
        <button
          onClick={runAnalysis}
          disabled={thinking || blocked}
          style={{
            background: blocked ? "rgba(255,77,109,0.08)" : thinking ? "rgba(0,229,160,0.1)" : "linear-gradient(135deg, #00e5a0, #00b37d)",
            border: blocked ? "1px solid rgba(255,77,109,0.2)" : "none",
            borderRadius: 10, padding: "10px 20px",
            color: blocked ? "#ff4d6d44" : thinking ? "#00e5a0" : "#001a12",
            fontFamily: "'Syne', sans-serif", fontWeight: 700, fontSize: 13,
            cursor: blocked || thinking ? "not-allowed" : "pointer",
            display: "flex", alignItems: "center", gap: 8, letterSpacing: "0.05em",
            transition: "all 0.2s",
          }}
        >
          {thinking ? (
            <><span style={{ display: "inline-block", width: 12, height: 12, border: "2px solid #00e5a0", borderTopColor: "transparent", borderRadius: "50%", animation: "spin 0.8s linear infinite" }} /> Analysing…</>
          ) : blocked ? "🚨 Blocked" : "▶ Run Analysis"}
        </button>
      </div>

      {blocked && (
        <div style={{ background: "rgba(255,77,109,0.08)", border: "1px solid rgba(255,77,109,0.2)", borderRadius: 10, padding: 12, color: "#ff4d6d", fontSize: 13 }}>
          {killSwitchActive ? "🚨 Daily loss limit reached — agent blocked until tomorrow." : "⚠ Agent paused after consecutive losses — reset the streak counter to resume."}
        </div>
      )}

      {error && (
        <div style={{ background: "rgba(255,77,109,0.1)", border: "1px solid rgba(255,77,109,0.3)", borderRadius: 10, padding: 12, color: "#ff4d6d", fontSize: 13 }}>{error}</div>
      )}

      {thinking && !analysis && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {["Fetching price action…", "Evaluating momentum signals…", "Computing risk/reward…"].map((t, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, color: "#666", fontSize: 13, animation: `fadeIn 0.4s ${i * 0.3}s both` }}>
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#00e5a0", animation: "pulse 1s infinite" }} />
              {t}
            </div>
          ))}
        </div>
      )}

      {analysis && (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
            <p style={{ color: "#aaa", fontSize: 14, lineHeight: 1.6, margin: 0, flex: 1 }}>{analysis.summary}</p>
            <div style={{
              background: `rgba(${analysis.overallSentiment === "BULLISH" ? "0,229,160" : analysis.overallSentiment === "BEARISH" ? "255,77,109" : "245,197,24"},0.12)`,
              border: `1px solid ${(sentColor[analysis.overallSentiment] || "#666")}40`,
              borderRadius: 8, padding: "6px 12px", whiteSpace: "nowrap",
              color: sentColor[analysis.overallSentiment] || "#fff",
              fontSize: 12, fontWeight: 700, fontFamily: "'Syne', sans-serif", letterSpacing: "0.08em",
            }}>{analysis.overallSentiment}</div>
          </div>

          {analysis.riskWarning && (
            <div style={{ background: "rgba(245,197,24,0.08)", border: "1px solid rgba(245,197,24,0.2)", borderRadius: 10, padding: "10px 14px", color: "#f5c518", fontSize: 13, display: "flex", gap: 8 }}>
              <span>⚠</span> {analysis.riskWarning}
            </div>
          )}

          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {analysis.signals?.map((sig, i) => (
              <div key={i} style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 12, padding: 14, display: "flex", alignItems: "center", gap: 14 }}>
                <div style={{ minWidth: 72 }}>
                  <div style={{ fontFamily: "'Syne', sans-serif", fontWeight: 700, fontSize: 13, color: "#fff" }}>{sig.symbol}</div>
                  <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.1em", marginTop: 3, color: sig.action === "BUY" ? "#00e5a0" : sig.action === "SELL" ? "#ff4d6d" : "#888" }}>{sig.action}</div>
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 12, color: "#777", lineHeight: 1.5 }}>{sig.rationale}</div>
                  <div style={{ display: "flex", gap: 16, marginTop: 6 }}>
                    <span style={{ fontSize: 11, color: "#555" }}>SL {sig.estimatedSL}</span>
                    <span style={{ fontSize: 11, color: "#555" }}>TP {sig.estimatedTP}</span>
                    <span style={{ fontSize: 11, color: "#00e5a088" }}>0.01 lots</span>
                  </div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontSize: 20, fontWeight: 700, fontFamily: "'Syne', sans-serif", color: sig.confidence >= 75 ? "#00e5a0" : sig.confidence >= 50 ? "#f5c518" : "#ff4d6d" }}>{sig.confidence}</div>
                  <div style={{ fontSize: 10, color: "#555", letterSpacing: "0.08em" }}>CONF%</div>
                </div>
                {sig.action !== "HOLD" && (
                  <button
                    onClick={() => onTrade(sig)}
                    style={{
                      background: sig.action === "BUY" ? "rgba(0,229,160,0.12)" : "rgba(255,77,109,0.12)",
                      border: `1px solid ${sig.action === "BUY" ? "#00e5a040" : "#ff4d6d40"}`,
                      borderRadius: 8, padding: "8px 14px",
                      color: sig.action === "BUY" ? "#00e5a0" : "#ff4d6d",
                      fontFamily: "'Syne', sans-serif", fontWeight: 700, fontSize: 12,
                      cursor: "pointer", whiteSpace: "nowrap",
                    }}
                  >Execute</button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {!analysis && !thinking && !blocked && (
        <div style={{ textAlign: "center", padding: "30px 0", color: "#444", fontSize: 14 }}>
          Press Run Analysis to let the AI evaluate current market conditions
        </div>
      )}
    </div>
  );
}

// ── Main Dashboard ────────────────────────────────────────────────────────────
export default function MT5AgentDashboard() {
  const [trades, setTrades]     = useState(INITIAL_TRADES);
  const [prices, setPrices]     = useState(MOCK_PRICES);
  const [activeTab, setActiveTab] = useState("dashboard");
  const [log, setLog]           = useState([
    { time: "08:14:03", msg: "BUY XAUUSD 0.01 lots @ 3301.20 — Agent [Safe Mode]", type: "trade" },
    { time: "09:02:47", msg: "SELL EURUSD 0.01 lots @ 1.08510 — Agent [Safe Mode]", type: "trade" },
    { time: "10:31:11", msg: "BUY USDZAR 0.01 lots @ 18.2900 — Agent [Safe Mode]", type: "trade" },
  ]);

  // Risk config state (mirrors bridge RISK_CONFIG)
  const [config, setConfig] = useState({
    safeMode:          true,
    fixedLots:         0.01,
    riskPct:           0.5,
    slPips:            50,
    tpRatio:           2.0,
    minConfidence:     80,
    maxPositions:      3,
    maxDailyLossPct:   3.0,
    maxLossPerTrade:   10,
    maxConsecLosses:   3,
    autoExecute:       false,
    balance:           10000,
    openPositions:     3,
  });

  // Session state
  const [session, setSession] = useState({
    dailyLoss:          0.0,
    consecutiveLosses:  0,
    openingBalance:     10000,
    tradestoday:        3,
  });

  const killSwitchActive = session.dailyLoss >= (session.openingBalance * config.maxDailyLossPct / 100);
  const agentPaused      = session.consecutiveLosses >= config.maxConsecLosses;

  // Live price simulation
  useEffect(() => {
    const tick = setInterval(() => {
      setPrices(prev => {
        const next = { ...prev };
        Object.keys(next).forEach(sym => {
          const jitter = (Math.random() - 0.49) * 0.001 * next[sym].bid;
          const dec    = sym.includes("ZAR") ? 4 : sym === "XAUUSD" ? 2 : 5;
          next[sym] = { ...next[sym], bid: +(next[sym].bid + jitter).toFixed(dec), ask: +(next[sym].ask + jitter).toFixed(dec) };
        });
        return next;
      });
    }, 1800);
    return () => clearInterval(tick);
  }, []);

  const totalProfit  = trades.filter(t => t.status === "open").reduce((s, t) => s + t.profit, 0);

  const addLog = (msg, type = "info") => {
    const time = new Date().toLocaleTimeString("en-ZA", { hour12: false });
    setLog(prev => [{ time, msg, type }, ...prev].slice(0, 60));
  };

  const handleTrade = useCallback((sig) => {
    if (killSwitchActive) { addLog("Trade blocked: daily loss limit active", "warn"); return; }
    if (agentPaused)      { addLog("Trade blocked: consecutive loss pause", "warn"); return; }
    if (config.openPositions >= config.maxPositions) { addLog(`Trade blocked: max ${config.maxPositions} positions`, "warn"); return; }

    const price   = prices[sig.symbol];
    const useLots = config.safeMode ? config.fixedLots : config.fixedLots;
    if (!price) return;

    const newTrade = {
      id: Date.now(), symbol: sig.symbol, type: sig.action,
      lots: useLots, openPrice: sig.action === "BUY" ? price.ask : price.bid,
      sl: sig.estimatedSL, tp: sig.estimatedTP, profit: 0,
      time: new Date().toLocaleTimeString("en-ZA", { hour12: false }), status: "open",
    };
    setTrades(prev => [...prev, newTrade]);
    setConfig(c => ({ ...c, openPositions: c.openPositions + 1 }));
    addLog(`${sig.action} ${sig.symbol} ${useLots} lots @ ${newTrade.openPrice} — conf ${sig.confidence}%${config.safeMode ? " [Safe Mode]" : ""}`, "trade");
  }, [prices, config, killSwitchActive, agentPaused]);

  const closeTrade = (id) => {
    const t = trades.find(tr => tr.id === id);
    if (!t) return;
    setTrades(prev => prev.map(tr => tr.id === id ? { ...tr, status: "closed" } : tr));
    setConfig(c => ({ ...c, openPositions: Math.max(0, c.openPositions - 1) }));
    if (t.profit < 0) {
      setSession(s => ({ ...s, dailyLoss: s.dailyLoss + Math.abs(t.profit), consecutiveLosses: s.consecutiveLosses + 1 }));
    } else {
      setSession(s => ({ ...s, consecutiveLosses: 0 }));
    }
    addLog(`Closed ${t.symbol} ${t.type} — P&L ${t.profit >= 0 ? "+" : ""}$${t.profit.toFixed(2)}`, t.profit >= 0 ? "win" : "loss");
  };

  const statCard = (label, value, sub, color = "#fff") => (
    <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 14, padding: "18px 20px" }}>
      <div style={{ fontSize: 11, color: "#555", letterSpacing: "0.12em", textTransform: "uppercase", fontFamily: "'Syne', sans-serif" }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 800, color, fontFamily: "'Syne', sans-serif", marginTop: 6, lineHeight: 1 }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: "#555", marginTop: 6 }}>{sub}</div>}
    </div>
  );

  const tabs = ["dashboard", "agent", "config"];

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: #080a0d; }
        @keyframes spin    { to { transform: rotate(360deg); } }
        @keyframes pulse   { 0%,100%{opacity:1} 50%{opacity:0.3} }
        @keyframes fadeIn  { from{opacity:0;transform:translateY(6px)} to{opacity:1;transform:translateY(0)} }
        @keyframes slideIn { from{opacity:0;transform:translateX(-8px)} to{opacity:1;transform:translateX(0)} }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: #222; border-radius: 2px; }
      `}</style>

      <div style={{ minHeight: "100vh", background: "#080a0d", color: "#fff", fontFamily: "'JetBrains Mono', monospace", paddingBottom: 60 }}>

        {/* Header */}
        <div style={{ borderBottom: "1px solid rgba(255,255,255,0.06)", padding: "18px 28px", display: "flex", alignItems: "center", justifyContent: "space-between", backdropFilter: "blur(12px)", position: "sticky", top: 0, zIndex: 100, background: "rgba(8,10,13,0.92)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <div style={{ width: 36, height: 36, borderRadius: 10, background: "linear-gradient(135deg, #00e5a0, #00b37d)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16 }}>⚡</div>
            <div>
              <div style={{ fontFamily: "'Syne', sans-serif", fontWeight: 800, fontSize: 16, letterSpacing: "-0.02em" }}>TITAN<span style={{ color: "#00e5a0" }}>·MT5</span></div>
              <div style={{ fontSize: 10, color: "#444", letterSpacing: "0.1em" }}>AI TRADING AGENT</div>
            </div>
          </div>

          <div style={{ display: "flex", gap: 6 }}>
            {tabs.map(t => (
              <button key={t} onClick={() => setActiveTab(t)} style={{
                background: activeTab === t ? "rgba(0,229,160,0.1)" : "transparent",
                border: activeTab === t ? "1px solid rgba(0,229,160,0.25)" : "1px solid transparent",
                borderRadius: 8, padding: "7px 16px", color: activeTab === t ? "#00e5a0" : "#555",
                fontFamily: "'Syne', sans-serif", fontWeight: 600, fontSize: 12, cursor: "pointer",
                letterSpacing: "0.06em", textTransform: "capitalize",
              }}>{t}</button>
            ))}
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            {/* Safe Mode pill in header */}
            <div style={{
              background: config.safeMode ? "rgba(0,229,160,0.1)" : "rgba(255,77,109,0.1)",
              border: `1px solid ${config.safeMode ? "rgba(0,229,160,0.2)" : "rgba(255,77,109,0.2)"}`,
              borderRadius: 20, padding: "4px 12px", fontSize: 11,
              color: config.safeMode ? "#00e5a0" : "#ff4d6d",
              fontFamily: "'Syne', sans-serif", fontWeight: 700, letterSpacing: "0.06em",
            }}>
              {config.safeMode ? "🛡 SAFE" : "⚡ DYNAMIC"}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ width: 8, height: 8, borderRadius: "50%", background: killSwitchActive ? "#ff4d6d" : "#00e5a0", boxShadow: `0 0 8px ${killSwitchActive ? "#ff4d6d" : "#00e5a0"}` }} />
              <span style={{ fontSize: 12, color: "#555" }}>{killSwitchActive ? "Kill Switch" : "MT5 Live"}</span>
            </div>
          </div>
        </div>

        <div style={{ padding: "28px 28px 0", maxWidth: 1200, margin: "0 auto" }}>

          {/* ── DASHBOARD TAB ── */}
          {activeTab === "dashboard" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 20, animation: "fadeIn 0.3s both" }}>

              {/* Safe Mode Banner — always visible on dashboard */}
              <SafeModeBanner safeMode={config.safeMode} onToggle={v => setConfig(c => ({ ...c, safeMode: v }))} />

              {/* Stats row */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 14 }}>
                {statCard("Balance", `$${config.balance.toLocaleString()}`, "FNB MT5 Live")}
                {statCard("Floating P&L", `${totalProfit >= 0 ? "+" : ""}$${totalProfit.toFixed(2)}`, `${trades.filter(t => t.status === "open").length} open`, totalProfit >= 0 ? "#00e5a0" : "#ff4d6d")}
                {statCard("Lot Size", config.safeMode ? "0.01" : `~${config.fixedLots}`, config.safeMode ? "Safe Mode locked" : "Dynamic", config.safeMode ? "#00e5a0" : "#f5c518")}
                {statCard("Positions", `${config.openPositions}/${config.maxPositions}`, "open / max")}
              </div>

              {/* Risk meters row */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
                <DailyLossMeter
                  dailyLoss={session.dailyLoss}
                  dailyLossLimit={config.maxDailyLossPct}
                  openingBalance={session.openingBalance}
                />
                <LossStreak
                  consecutive={session.consecutiveLosses}
                  maxAllowed={config.maxConsecLosses}
                  onReset={() => setSession(s => ({ ...s, consecutiveLosses: 0 }))}
                />
              </div>

              {/* Price ticker */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
                {Object.entries(prices).map(([sym, d]) => (
                  <div key={sym} style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 12, padding: "14px 16px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div>
                      <div style={{ fontFamily: "'Syne', sans-serif", fontWeight: 700, fontSize: 13 }}>{sym}</div>
                      <div style={{ fontSize: 18, fontWeight: 500, marginTop: 4, color: "#ddd" }}>{d.bid}</div>
                      <div style={{ fontSize: 11, color: d.change >= 0 ? "#00e5a0" : "#ff4d6d", marginTop: 3 }}>{d.change >= 0 ? "▲" : "▼"} {Math.abs(d.change)}%</div>
                    </div>
                    <Spark positive={d.change >= 0} />
                  </div>
                ))}
              </div>

              {/* Open Positions */}
              <div style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 16, overflow: "hidden" }}>
                <div style={{ padding: "16px 20px", borderBottom: "1px solid rgba(255,255,255,0.05)", display: "flex", justifyContent: "space-between" }}>
                  <div style={{ fontFamily: "'Syne', sans-serif", fontWeight: 700, fontSize: 15 }}>Open Positions</div>
                  <div style={{ fontSize: 11, color: "#555" }}>All trades: 0.01 lots{config.safeMode ? " (Safe Mode)" : ""}</div>
                </div>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                  <thead>
                    <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
                      {["Symbol", "Type", "Lots", "Open", "SL", "TP", "P&L", "Time", ""].map(h => (
                        <th key={h} style={{ padding: "10px 16px", textAlign: "left", color: "#444", fontWeight: 500, letterSpacing: "0.08em", fontSize: 11 }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {trades.filter(t => t.status === "open").map(t => (
                      <tr key={t.id} style={{ borderBottom: "1px solid rgba(255,255,255,0.03)", animation: "slideIn 0.3s both" }}>
                        <td style={{ padding: "12px 16px", fontFamily: "'Syne', sans-serif", fontWeight: 700 }}>{t.symbol}</td>
                        <td style={{ padding: "12px 16px", color: t.type === "BUY" ? "#00e5a0" : "#ff4d6d", fontWeight: 700, letterSpacing: "0.06em" }}>{t.type}</td>
                        <td style={{ padding: "12px 16px", color: "#00e5a0" }}>{t.lots}</td>
                        <td style={{ padding: "12px 16px", color: "#888" }}>{t.openPrice}</td>
                        <td style={{ padding: "12px 16px", color: "#ff4d6d88" }}>{t.sl}</td>
                        <td style={{ padding: "12px 16px", color: "#00e5a088" }}>{t.tp}</td>
                        <td style={{ padding: "12px 16px", color: t.profit >= 0 ? "#00e5a0" : "#ff4d6d", fontWeight: 700 }}>{t.profit >= 0 ? "+" : ""}${t.profit.toFixed(2)}</td>
                        <td style={{ padding: "12px 16px", color: "#444" }}>{t.time}</td>
                        <td style={{ padding: "12px 16px" }}>
                          <button onClick={() => closeTrade(t.id)} style={{ background: "rgba(255,77,109,0.1)", border: "1px solid rgba(255,77,109,0.2)", borderRadius: 6, padding: "4px 10px", color: "#ff4d6d", cursor: "pointer", fontSize: 11, fontFamily: "'Syne', sans-serif" }}>Close</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Log */}
              <div style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 16, padding: 20 }}>
                <div style={{ fontFamily: "'Syne', sans-serif", fontWeight: 700, fontSize: 15, marginBottom: 14 }}>Activity Log</div>
                <div style={{ maxHeight: 180, overflowY: "auto", display: "flex", flexDirection: "column", gap: 6 }}>
                  {log.map((l, i) => (
                    <div key={i} style={{ display: "flex", gap: 12, alignItems: "flex-start", fontSize: 12, animation: "slideIn 0.25s both" }}>
                      <span style={{ color: "#333", minWidth: 70 }}>{l.time}</span>
                      <span style={{ color: l.type === "trade" ? "#00e5a0" : l.type === "win" ? "#00e5a0" : l.type === "loss" || l.type === "warn" ? "#ff4d6d" : "#666" }}>
                        {l.type === "trade" ? "◆" : l.type === "win" ? "✓" : l.type === "loss" ? "✕" : l.type === "warn" ? "⚠" : "·"}
                      </span>
                      <span style={{ color: "#777" }}>{l.msg}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* ── AGENT TAB ── */}
          {activeTab === "agent" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 16, animation: "fadeIn 0.3s both" }}>
              <SafeModeBanner safeMode={config.safeMode} onToggle={v => setConfig(c => ({ ...c, safeMode: v }))} />
              <AgentPanel
                config={{ ...config, dailyLoss: session.dailyLoss, consecutiveLosses: session.consecutiveLosses }}
                onTrade={handleTrade}
                killSwitchActive={killSwitchActive}
                agentPaused={agentPaused}
              />
            </div>
          )}

          {/* ── CONFIG TAB ── */}
          {activeTab === "config" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 20, animation: "fadeIn 0.3s both" }}>

              {/* Safe Mode — top of config, most prominent */}
              <div style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 16, padding: 24 }}>
                <div style={{ fontFamily: "'Syne', sans-serif", fontWeight: 700, fontSize: 16, marginBottom: 4 }}>Lot Size Protection</div>
                <div style={{ fontSize: 12, color: "#555", marginBottom: 16 }}>Safe Mode is the most important setting on this panel.</div>
                <Toggle
                  value={config.safeMode}
                  onChange={v => setConfig(c => ({ ...c, safeMode: v }))}
                  label="Safe Mode — Fixed 0.01 Lots"
                  sublabel="Overrides all dynamic sizing. Every trade uses exactly 0.01 lots. Recommended while testing."
                />
                <div style={{ marginTop: 16 }}>
                  <label style={{ fontSize: 11, color: "#555", letterSpacing: "0.1em", textTransform: "uppercase", display: "block", marginBottom: 8 }}>Fixed lot size</label>
                  <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <input type="range" min={0.01} max={1.0} step={0.01} value={config.fixedLots}
                      onChange={e => setConfig(c => ({ ...c, fixedLots: parseFloat(e.target.value) }))}
                      style={{ flex: 1, accentColor: "#00e5a0" }} />
                    <span style={{ minWidth: 60, color: "#00e5a0", fontFamily: "'Syne', sans-serif", fontWeight: 700 }}>{config.fixedLots} lots</span>
                  </div>
                </div>
              </div>

              {/* Kill switches */}
              <div style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 16, padding: 24 }}>
                <div style={{ fontFamily: "'Syne', sans-serif", fontWeight: 700, fontSize: 16, marginBottom: 16 }}>Kill Switches</div>
                {[
                  { label: "Max Daily Loss %",      key: "maxDailyLossPct",  min: 0.5, max: 10, step: 0.5, suffix: "%" },
                  { label: "Max Loss Per Trade ($)", key: "maxLossPerTrade",  min: 1,   max: 100, step: 1,  suffix: "$" },
                  { label: "Max Consecutive Losses", key: "maxConsecLosses", min: 1,   max: 10, step: 1,   suffix: "" },
                ].map(f => (
                  <div key={f.key} style={{ marginBottom: 18 }}>
                    <label style={{ fontSize: 11, color: "#555", letterSpacing: "0.1em", textTransform: "uppercase", display: "block", marginBottom: 8 }}>{f.label}</label>
                    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                      <input type="range" min={f.min} max={f.max} step={f.step} value={config[f.key]}
                        onChange={e => setConfig(c => ({ ...c, [f.key]: parseFloat(e.target.value) }))}
                        style={{ flex: 1, accentColor: "#ff4d6d" }} />
                      <span style={{ minWidth: 70, color: "#ff4d6d", fontFamily: "'Syne', sans-serif", fontWeight: 700 }}>{f.suffix === "$" ? `$${config[f.key]}` : `${config[f.key]}${f.suffix}`}</span>
                    </div>
                  </div>
                ))}
              </div>

              {/* Trade quality */}
              <div style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 16, padding: 24 }}>
                <div style={{ fontFamily: "'Syne', sans-serif", fontWeight: 700, fontSize: 16, marginBottom: 16 }}>Trade Quality Filters</div>
                {[
                  { label: "Min AI Confidence",  key: "minConfidence", min: 50, max: 100, step: 5,  suffix: "%" },
                  { label: "Stop-Loss (pips)",   key: "slPips",        min: 10, max: 200, step: 5,  suffix: " pips" },
                  { label: "Take-Profit Ratio",  key: "tpRatio",       min: 1,  max: 5,   step: 0.5, suffix: ":1" },
                  { label: "Max Positions",      key: "maxPositions",  min: 1,  max: 10,  step: 1,  suffix: "" },
                ].map(f => (
                  <div key={f.key} style={{ marginBottom: 18 }}>
                    <label style={{ fontSize: 11, color: "#555", letterSpacing: "0.1em", textTransform: "uppercase", display: "block", marginBottom: 8 }}>{f.label}</label>
                    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                      <input type="range" min={f.min} max={f.max} step={f.step} value={config[f.key]}
                        onChange={e => setConfig(c => ({ ...c, [f.key]: parseFloat(e.target.value) }))}
                        style={{ flex: 1, accentColor: "#00e5a0" }} />
                      <span style={{ minWidth: 70, color: "#00e5a0", fontFamily: "'Syne', sans-serif", fontWeight: 700 }}>{config[f.key]}{f.suffix}</span>
                    </div>
                  </div>
                ))}
              </div>

              {/* Agent behaviour */}
              <div style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 16, padding: 24 }}>
                <div style={{ fontFamily: "'Syne', sans-serif", fontWeight: 700, fontSize: 16, marginBottom: 4 }}>Agent Behaviour</div>
                <div style={{ fontSize: 12, color: "#555", marginBottom: 16 }}>Auto-execute requires Safe Mode ON and confidence ≥ {config.minConfidence}%</div>
                <Toggle
                  value={config.autoExecute}
                  onChange={v => setConfig(c => ({ ...c, autoExecute: v }))}
                  label="Auto-Execute Signals"
                  sublabel={`Agent places trades automatically when all guards pass. Safe Mode: ${config.safeMode ? "ON ✓" : "OFF — enable Safe Mode first"}`}
                />
                <div style={{ marginTop: 16, paddingTop: 16, borderTop: "1px solid rgba(255,255,255,0.05)" }}>
                  <div style={{ fontFamily: "'Syne', sans-serif", fontWeight: 600, fontSize: 14, marginBottom: 8 }}>MT5 Bridge Endpoint</div>
                  <input defaultValue="http://localhost:8000" style={{ width: "100%", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, padding: "10px 14px", color: "#00e5a0", fontFamily: "'JetBrains Mono', monospace", fontSize: 13 }} />
                </div>
              </div>

              <div style={{ background: "rgba(245,197,24,0.06)", border: "1px solid rgba(245,197,24,0.15)", borderRadius: 14, padding: 18 }}>
                <div style={{ fontFamily: "'Syne', sans-serif", fontWeight: 700, color: "#f5c518", marginBottom: 8 }}>⚠ Reminder</div>
                <p style={{ fontSize: 13, color: "#888", lineHeight: 1.7 }}>
                  Always validate on a <strong style={{ color: "#aaa" }}>demo account</strong> before going live. Safe Mode is ON by default — 
                  keep it on until you've observed at least 20 agent trades performing to your satisfaction. 
                  The 3% daily loss kill switch will protect your account even if you leave the agent unattended.
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
