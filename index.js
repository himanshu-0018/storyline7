import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from 'redis';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_STORYLINE_CHAT_ID = process.env.TELEGRAM_STORYLINE_CHAT_ID;

// 6 Entry Channels
const TG_5M_GOD = process.env.TG_5M_GOD;
const TG_3M_GOD = process.env.TG_3M_GOD;
const TG_1M_GOD = process.env.TG_1M_GOD;
const TG_5M_PARTIAL = process.env.TG_5M_PARTIAL;
const TG_3M_PARTIAL = process.env.TG_3M_PARTIAL;
const TG_1M_PARTIAL = process.env.TG_1M_PARTIAL;

const ALIGNMENT_THRESHOLD = 3; // 1H + 30M + 15M
const REDIS_STATE_KEY = process.env.REDIS_KEY || 'godModeState_v3';
const REDIS_LOG_KEY = REDIS_STATE_KEY + '_activityLog';
const REDIS_STATS_KEY = REDIS_STATE_KEY + '_tradeStats';

const ZONE_TIMEFRAMES = ["1H", "30M", "15M"];
const ENTRY_TIMEFRAMES = ["5M", "3M", "1M"];

let marketState = {};
let activityLog = [];
let tradeStats = {};
let clients = [];

// ══════════════════════════════════════════════
// BROADCAST
// ══════════════════════════════════════════════
function broadcastAll(extras = {}) {
    const data = JSON.stringify({ marketState, activityLog, ...extras });
    clients.forEach(client => client.res.write(`data: ${data}\n\n`));
}

function broadcastSoundAlert(symbol, direction, channel) {
    const data = JSON.stringify({ soundAlert: true, symbol, direction, channel });
    clients.forEach(client => client.res.write(`data: ${data}\n\n`));
}

// ══════════════════════════════════════════════
// TELEGRAM
// ══════════════════════════════════════════════
async function sendTelegram(chatId, message) {
    if (!TELEGRAM_TOKEN || !chatId) return false;
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
    try {
        const resp = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: "HTML" })
        });
        return resp.ok;
    } catch (err) {
        console.error("Telegram Error:", err);
        return false;
    }
}

async function sendStorylineAlert(message) {
    return sendTelegram(TELEGRAM_STORYLINE_CHAT_ID, message);
}

function getGodChannel(entryTf) {
    if (entryTf === "5M") return TG_5M_GOD;
    if (entryTf === "3M") return TG_3M_GOD;
    if (entryTf === "1M") return TG_1M_GOD;
    return null;
}

function getPartialChannel(entryTf) {
    if (entryTf === "5M") return TG_5M_PARTIAL;
    if (entryTf === "3M") return TG_3M_PARTIAL;
    if (entryTf === "1M") return TG_1M_PARTIAL;
    return null;
}

// ══════════════════════════════════════════════
// ACTIVITY LOG
// ══════════════════════════════════════════════
async function pushLogEvent(symbol, type, message, timestamp = null) {
    const ts = timestamp || Date.now();
    const isDup = activityLog.some(e =>
        e.symbol === symbol && e.type === type && Math.abs((e.timestamp || 0) - ts) < 5000
    );
    if (isDup) return;
    activityLog.unshift({ symbol, type, message, timestamp: ts });
    if (activityLog.length > 100) activityLog = activityLog.slice(0, 100);
    await redisClient.set(REDIS_LOG_KEY, JSON.stringify(activityLog));
}

// ══════════════════════════════════════════════
// TRADE STATISTICS ENGINE
// ══════════════════════════════════════════════
async function recordTradeEvent(symbol, entryTf, direction, action, entry, sl, tp, rr, touchedLevel, channel) {
    if (!tradeStats[symbol]) {
        tradeStats[symbol] = {};
    }
    if (!tradeStats[symbol][entryTf]) {
        tradeStats[symbol][entryTf] = {
            total_signals: 0,
            total_entries: 0,
            tp_hits: 0,
            sl_hits: 0,
            pending: 0,
            active: 0,
            trades: []
        };
    }

    const stats = tradeStats[symbol][entryTf];

    if (action === "SIGNAL") {
        stats.total_signals++;
        stats.pending++;
        stats.trades.push({
            id: `${symbol}_${entryTf}_${Date.now()}`,
            direction,
            entry: parseFloat(entry),
            sl: parseFloat(sl),
            tp: parseFloat(tp),
            rr: parseFloat(rr),
            touched_level: touchedLevel,
            channel: channel || 'NONE',
            status: 'SIGNAL',
            signal_time: Date.now(),
            entry_time: null,
            result_time: null
        });
    } else if (action === "ENTRY_FILLED") {
        stats.total_entries++;
        if (stats.pending > 0) stats.pending--;
        stats.active++;
        // Update last matching trade
        for (let i = stats.trades.length - 1; i >= 0; i--) {
            if (stats.trades[i].status === 'SIGNAL' &&
                stats.trades[i].direction === direction &&
                Math.abs(stats.trades[i].entry - parseFloat(entry)) < 0.0001) {
                stats.trades[i].status = 'ACTIVE';
                stats.trades[i].entry_time = Date.now();
                break;
            }
        }
    } else if (action === "TP_HIT") {
        stats.tp_hits++;
        if (stats.active > 0) stats.active--;
        for (let i = stats.trades.length - 1; i >= 0; i--) {
            if ((stats.trades[i].status === 'ACTIVE' || stats.trades[i].status === 'SIGNAL') &&
                stats.trades[i].direction === direction &&
                Math.abs(stats.trades[i].entry - parseFloat(entry)) < 0.0001) {
                stats.trades[i].status = 'TP_HIT';
                stats.trades[i].result_time = Date.now();
                break;
            }
        }
    } else if (action === "SL_HIT") {
        stats.sl_hits++;
        if (stats.active > 0) stats.active--;
        for (let i = stats.trades.length - 1; i >= 0; i--) {
            if ((stats.trades[i].status === 'ACTIVE' || stats.trades[i].status === 'SIGNAL') &&
                stats.trades[i].direction === direction &&
                Math.abs(stats.trades[i].entry - parseFloat(entry)) < 0.0001) {
                stats.trades[i].status = 'SL_HIT';
                stats.trades[i].result_time = Date.now();
                break;
            }
        }
    }

    // Keep only last 200 trades per symbol/tf
    if (stats.trades.length > 200) {
        stats.trades = stats.trades.slice(-200);
    }

    await redisClient.set(REDIS_STATS_KEY, JSON.stringify(tradeStats));
}

// ══════════════════════════════════════════════
// ALIGNMENT CALCULATOR
// ══════════════════════════════════════════════
function recalculateAlignment(symbol) {
    if (!marketState[symbol]) return { dominantState: "NONE", alignCount: 0 };

    const tfs = marketState[symbol].timeframes || {};
    let bullCount = 0;
    let bearCount = 0;

    ZONE_TIMEFRAMES.forEach(tf => {
        if (tfs[tf] === "BULLISH") bullCount++;
        if (tfs[tf] === "BEARISH") bearCount++;
    });

    let dominantState = "NONE";
    let alignCount = 0;
    if (bullCount >= ALIGNMENT_THRESHOLD) { dominantState = "BULLISH"; alignCount = bullCount; }
    if (bearCount >= ALIGNMENT_THRESHOLD) { dominantState = "BEARISH"; alignCount = bearCount; }

    // Partial alignment (2/3)
    let partialState = "NONE";
    let partialCount = 0;
    if (bullCount >= 2 && dominantState === "NONE") { partialState = "BULLISH"; partialCount = bullCount; }
    if (bearCount >= 2 && dominantState === "NONE") { partialState = "BEARISH"; partialCount = bearCount; }

    marketState[symbol].alignCount = Math.max(bullCount, bearCount);
    marketState[symbol].partialState = partialState;
    marketState[symbol].partialCount = partialCount;

    return { dominantState, alignCount, bullCount, bearCount, partialState, partialCount };
}

// ══════════════════════════════════════════════
// ENTRY VALIDATORS
// ══════════════════════════════════════════════
function validateGodMode(symbol, signalDirection) {
    if (!marketState[symbol]) return { valid: false, reason: "Symbol not tracked" };
    const godState = marketState[symbol].lastAlertedState;
    if (godState === "NONE") return { valid: false, reason: "No God-Mode alignment (need 3/3)" };
    if (signalDirection !== godState) return { valid: false, reason: `Direction mismatch: Signal=${signalDirection}, God=${godState}` };
    return { valid: true, reason: "God-Mode confirmed (3/3)", godState };
}

function validatePartial(symbol, signalDirection) {
    if (!marketState[symbol]) return { valid: false, reason: "Symbol not tracked" };

    const tfs = marketState[symbol].timeframes || {};
    let bullCount = 0, bearCount = 0;
    ZONE_TIMEFRAMES.forEach(tf => {
        if (tfs[tf] === "BULLISH") bullCount++;
        if (tfs[tf] === "BEARISH") bearCount++;
    });

    const matchCount = signalDirection === "BULLISH" ? bullCount : bearCount;
    if (matchCount < 2) return { valid: false, reason: `Only ${matchCount}/3 aligned` };
    return { valid: true, reason: `Partial alignment (${matchCount}/3)`, alignCount: matchCount };
}

// ══════════════════════════════════════════════
// NORMALIZE TF STRING
// ══════════════════════════════════════════════
function normalizeTf(tf) {
    if (!tf) return null;
    const upper = tf.toUpperCase().trim();
    const map = {
        "1": "1M", "1M": "1M", "1MIN": "1M",
        "3": "3M", "3M": "3M", "3MIN": "3M",
        "5": "5M", "5M": "5M", "5MIN": "5M",
        "15": "15M", "15M": "15M", "15MIN": "15M",
        "30": "30M", "30M": "30M", "30MIN": "30M",
        "60": "1H", "1H": "1H", "1HR": "1H",
        "240": "4H", "4H": "4H",
        "1D": "1D", "D": "1D"
    };
    return map[upper] || upper;
}

// ══════════════════════════════════════════════
// REDIS BOOT
// ══════════════════════════════════════════════
const redisClient = createClient({ url: process.env.REDIS_URL });
redisClient.on('error', (err) => console.error('Redis Client Error:', err));
await redisClient.connect();
console.log('✅ Connected to Redis');

const savedData = await redisClient.get(REDIS_STATE_KEY);
if (savedData) {
    marketState = JSON.parse(savedData);
    console.log(`💾 Restored state from: ${REDIS_STATE_KEY} (${Object.keys(marketState).length} symbols)`);

    // Re-sync all symbols
    for (const symbol in marketState) {
        // Clean old TFs
        const obsolete = ["1D", "4H", "1W", "1M"];
        obsolete.forEach(oldTf => {
            if (marketState[symbol].timeframes) delete marketState[symbol].timeframes[oldTf];
            if (marketState[symbol].breakouts) delete marketState[symbol].breakouts[oldTf];
            if (marketState[symbol].stopLosses) delete marketState[symbol].stopLosses[oldTf];
        });

        const { dominantState } = recalculateAlignment(symbol);
        if (dominantState !== "NONE") {
            if (marketState[symbol].lastAlertedState !== dominantState) {
                console.log(`🔄 [BOOT FIX] ${symbol}: "${marketState[symbol].lastAlertedState}" → "${dominantState}"`);
                marketState[symbol].lastAlertedState = dominantState;
                if (!marketState[symbol].lastGodModeStartTime) {
                    marketState[symbol].lastGodModeStartTime = Date.now();
                }
            }
        } else {
            if (marketState[symbol].lastAlertedState !== "NONE") {
                console.log(`🔄 [BOOT FIX] ${symbol}: "${marketState[symbol].lastAlertedState}" → "NONE"`);
                marketState[symbol].lastAlertedState = "NONE";
            }
        }
    }
    await redisClient.set(REDIS_STATE_KEY, JSON.stringify(marketState));
} else {
    console.log(`🆕 No data found for: ${REDIS_STATE_KEY}`);
}

const savedLog = await redisClient.get(REDIS_LOG_KEY);
if (savedLog) {
    activityLog = JSON.parse(savedLog);
    console.log(`📋 Restored ${activityLog.length} log entries`);
}

const savedStats = await redisClient.get(REDIS_STATS_KEY);
if (savedStats) {
    tradeStats = JSON.parse(savedStats);
    console.log(`📊 Restored trade stats for ${Object.keys(tradeStats).length} symbols`);
} else {
    console.log(`📊 No trade stats found`);
}

// ══════════════════════════════════════════════
// API ENDPOINTS
// ══════════════════════════════════════════════
app.get('/api/state', (req, res) => {
    res.json({ marketState, activityLog });
});

app.get('/api/stats', (req, res) => {
    res.json({ tradeStats });
});

app.get('/api/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const clientId = Date.now();
    clients.push({ id: clientId, res });

    const keepAlive = setInterval(() => res.write(': keepalive\n\n'), 15000);
    req.on('close', () => {
        clearInterval(keepAlive);
        clients = clients.filter(c => c.id !== clientId);
    });
});

// ══════════════════════════════════════════════
// DELETE ENDPOINT
// ══════════════════════════════════════════════
app.post('/api/delete', async (req, res) => {
    const { symbol, action } = req.body;
    if (!symbol || action !== 'DELETE') return res.status(400).send("Invalid Delete Payload");

    const sym = symbol.toUpperCase().trim();
    console.log(`\n[PURGE] ${sym}`);

    if (marketState[sym]) {
        delete marketState[sym];
        await redisClient.set(REDIS_STATE_KEY, JSON.stringify(marketState));
        await pushLogEvent(sym, 'NONE', `🗑️ Manually Purged`, Date.now());
        broadcastAll();
        return res.status(200).send("Purged");
    }
    return res.status(404).send("Symbol not found");
});

// ══════════════════════════════════════════════
// DELETE STATS ENDPOINT
// ══════════════════════════════════════════════
app.post('/api/delete-stats', async (req, res) => {
    const { symbol } = req.body;
    if (!symbol) return res.status(400).send("Invalid payload");

    const sym = symbol.toUpperCase().trim();

    if (sym === "ALL") {
        tradeStats = {};
        await redisClient.set(REDIS_STATS_KEY, JSON.stringify(tradeStats));
        console.log(`[STATS PURGE] All stats cleared`);
        return res.status(200).send("All stats cleared");
    }

    if (tradeStats[sym]) {
        delete tradeStats[sym];
        await redisClient.set(REDIS_STATS_KEY, JSON.stringify(tradeStats));
        console.log(`[STATS PURGE] ${sym} stats cleared`);
        return res.status(200).send("Stats cleared");
    }
    return res.status(404).send("No stats for symbol");
});

// ══════════════════════════════════════════════
// UNIFIED WEBHOOK RECEIVER
// ══════════════════════════════════════════════
app.post('/webhook', async (req, res) => {
    const payload = req.body;

    const isStoryline = payload.state !== undefined && payload.tf !== undefined && !payload.type;
    const isEntry = payload.type !== undefined;

    // ─────────────────────────────────────────
    // STORYLINE WEBHOOK (1H, 30M, 15M)
    // ─────────────────────────────────────────
    if (isStoryline) {
        const { symbol, state } = payload;
        const tf = normalizeTf(payload.tf);
        const bo = payload.bo;
        const sl = payload.sl;

        if (!symbol || !tf || !state) return res.status(400).send("Invalid Storyline Payload");

        // Only accept 1H, 30M, 15M
        if (!ZONE_TIMEFRAMES.includes(tf)) {
            console.log(`[STORYLINE] ${symbol} | ${tf} ignored — not tracked`);
            return res.status(200).send("OK");
        }

        console.log(`\n[STORYLINE] ${symbol} | ${tf} -> ${state} | BO: ${bo || 'N/A'} | SL: ${sl || 'N/A'}`);

        if (!marketState[symbol]) {
            marketState[symbol] = {
                timeframes: { "1H": "NONE", "30M": "NONE", "15M": "NONE" },
                breakouts: { "1H": null, "30M": null, "15M": null },
                stopLosses: { "1H": null, "30M": null, "15M": null },
                lastAlertedState: "NONE",
                lastGodModeStartTime: null,
                alignCount: 0,
                partialState: "NONE",
                partialCount: 0
            };
        }

        // Ensure structure
        if (!marketState[symbol].timeframes) marketState[symbol].timeframes = { "1H": "NONE", "30M": "NONE", "15M": "NONE" };
        if (!marketState[symbol].breakouts) marketState[symbol].breakouts = { "1H": null, "30M": null, "15M": null };
        if (!marketState[symbol].stopLosses) marketState[symbol].stopLosses = { "1H": null, "30M": null, "15M": null };

        marketState[symbol].timeframes[tf] = state;
        if (bo !== undefined) marketState[symbol].breakouts[tf] = bo;
        if (sl !== undefined) marketState[symbol].stopLosses[tf] = sl;

        const prevAlertedState = marketState[symbol].lastAlertedState;
        const { dominantState, alignCount, bullCount, bearCount, partialState, partialCount } = recalculateAlignment(symbol);

        console.log(`[ALIGNMENT] ${symbol} -> Dominant: ${dominantState} | Bulls: ${bullCount}/3 | Bears: ${bearCount}/3 | Partial: ${partialState}(${partialCount}/3)`);

        // God-Mode ON (3/3)
        if (dominantState !== "NONE" && dominantState !== prevAlertedState) {
            const now = Date.now();
            marketState[symbol].lastGodModeStartTime = now;
            marketState[symbol].lastAlertedState = dominantState;

            const emoji = dominantState === "BULLISH" ? "🚀 🐂" : "🩸 🐻";
            let msg = `<b>${emoji} GOD-MODE: ${symbol}</b>\n\n`;
            msg += `<b>Alignment:</b> ${dominantState} (3/3)\n`;
            msg += `<b>1H:</b> ${marketState[symbol].timeframes["1H"]}\n`;
            msg += `<b>30M:</b> ${marketState[symbol].timeframes["30M"]}\n`;
            msg += `<b>15M:</b> ${marketState[symbol].timeframes["15M"]}\n`;
            msg += `\n<b>Confluence:</b> 1H + 30M + 15M aligned ✅`;
            await sendStorylineAlert(msg);

            await pushLogEvent(symbol, dominantState, `GOD-MODE: ${dominantState} (3/3) aligned`, now);
            console.log(`[GOD-MODE ON] ${symbol} → ${dominantState} | 3-way confluence`);

        // God-Mode OFF
        } else if (dominantState === "NONE" && prevAlertedState !== "NONE") {
            marketState[symbol].lastAlertedState = "NONE";

            let msg = `<b>⚠️ ALIGNMENT LOST: ${symbol}</b>\n\n`;
            msg += `Previously: ${prevAlertedState} (3/3)\n`;
            msg += `Now: ${partialState !== "NONE" ? partialState + ` (${partialCount}/3)` : 'No alignment'}\n`;
            await sendStorylineAlert(msg);

            await pushLogEvent(symbol, 'NONE', `Alignment Lost: ${prevAlertedState} broken`, Date.now());
            console.log(`[GOD-MODE OFF] ${symbol} → NONE`);
        }

        await redisClient.set(REDIS_STATE_KEY, JSON.stringify(marketState));
        broadcastAll();
        return res.status(200).send("OK");
    }

    // ─────────────────────────────────────────
    // ENTRY SIGNAL WEBHOOK (1M, 3M, 5M)
    // ─────────────────────────────────────────
    if (isEntry) {
        const { symbol, type, direction, entry, sl, tp, rr, touched_level, action } = payload;
        const entryTf = normalizeTf(payload.tf);

        if (!symbol || !type || !direction || entry === undefined || sl === undefined) {
            return res.status(400).send("Invalid Entry Payload");
        }

        console.log(`\n[ENTRY] ${symbol} | ${type} | ${direction} | ${action} | TF: ${entryTf} | Entry: ${entry} | SL: ${sl}`);

        // Record to stats engine
        const channelUsed = action === "SIGNAL" ? "pending" : "tracked";
        await recordTradeEvent(symbol, entryTf, direction, action, entry, sl, tp, rr, touched_level, channelUsed);

        // Only send Telegram on SIGNAL action
        if (action === "SIGNAL") {
            let soundTriggered = false;

            // ── GOD MODE CHECK (3/3) ──
            const godCheck = validateGodMode(symbol, direction);
            if (godCheck.valid) {
                const chatId = getGodChannel(entryTf);
                if (chatId) {
                    const emoji = direction === "BULLISH" ? "🟢 🐂" : "🔴 🐻";
                    let msg = `<b>${emoji} GOD-MODE ENTRY: ${symbol}</b>\n\n`;
                    msg += `<b>Type:</b> ${type}\n`;
                    msg += `<b>TF:</b> ${entryTf}\n`;
                    msg += `<b>Entry:</b> <code>${entry}</code>\n`;
                    msg += `<b>SL:</b> <code>${sl}</code>\n`;
                    if (tp) msg += `<b>TP:</b> <code>${tp}</code>\n`;
                    if (rr) msg += `<b>R:R:</b> ${rr}\n`;
                    if (touched_level) msg += `<b>Level:</b> ${touched_level}\n`;
                    msg += `\n<b>Alignment:</b> ✅ GOD-MODE (3/3)\n`;
                    msg += `<b>1H:</b> ${marketState[symbol]?.timeframes?.["1H"] || "?"}\n`;
                    msg += `<b>30M:</b> ${marketState[symbol]?.timeframes?.["30M"] || "?"}\n`;
                    msg += `<b>15M:</b> ${marketState[symbol]?.timeframes?.["15M"] || "?"}`;

                    const sent = await sendTelegram(chatId, msg);
                    if (sent) {
                        console.log(`✅ [GOD ${entryTf}] Sent to Telegram for ${symbol}`);
                        soundTriggered = true;

                        // Update channel in stats
                        if (tradeStats[symbol]?.[entryTf]?.trades) {
                            const trades = tradeStats[symbol][entryTf].trades;
                            for (let i = trades.length - 1; i >= 0; i--) {
                                if (trades[i].status === 'SIGNAL' && trades[i].direction === direction) {
                                    trades[i].channel = `GOD_${entryTf}`;
                                    break;
                                }
                            }
                            await redisClient.set(REDIS_STATS_KEY, JSON.stringify(tradeStats));
                        }
                    }
                }
            } else {
                console.log(`❌ [GOD ${entryTf}] ${symbol}: ${godCheck.reason}`);
            }

            // ── PARTIAL CHECK (2/3) ──
            const partialCheck = validatePartial(symbol, direction);
            if (partialCheck.valid && !godCheck.valid) {
                const chatId = getPartialChannel(entryTf);
                if (chatId) {
                    const emoji = direction === "BULLISH" ? "🟡 🐂" : "🟠 🐻";
                    let msg = `<b>${emoji} PARTIAL ENTRY: ${symbol}</b>\n\n`;
                    msg += `<b>Type:</b> ${type}\n`;
                    msg += `<b>TF:</b> ${entryTf}\n`;
                    msg += `<b>Entry:</b> <code>${entry}</code>\n`;
                    msg += `<b>SL:</b> <code>${sl}</code>\n`;
                    if (tp) msg += `<b>TP:</b> <code>${tp}</code>\n`;
                    if (rr) msg += `<b>R:R:</b> ${rr}\n`;
                    if (touched_level) msg += `<b>Level:</b> ${touched_level}\n`;
                    msg += `\n<b>Alignment:</b> ⚠️ Partial (${partialCheck.alignCount}/3)\n`;
                    msg += `<b>1H:</b> ${marketState[symbol]?.timeframes?.["1H"] || "?"}\n`;
                    msg += `<b>30M:</b> ${marketState[symbol]?.timeframes?.["30M"] || "?"}\n`;
                    msg += `<b>15M:</b> ${marketState[symbol]?.timeframes?.["15M"] || "?"}`;

                    const sent = await sendTelegram(chatId, msg);
                    if (sent) {
                        console.log(`✅ [PARTIAL ${entryTf}] Sent to Telegram for ${symbol}`);
                        if (!soundTriggered) soundTriggered = true;

                        if (tradeStats[symbol]?.[entryTf]?.trades) {
                            const trades = tradeStats[symbol][entryTf].trades;
                            for (let i = trades.length - 1; i >= 0; i--) {
                                if (trades[i].status === 'SIGNAL' && trades[i].direction === direction) {
                                    trades[i].channel = `PARTIAL_${entryTf}`;
                                    break;
                                }
                            }
                            await redisClient.set(REDIS_STATS_KEY, JSON.stringify(tradeStats));
                        }
                    }
                }
            } else if (!godCheck.valid) {
                console.log(`❌ [PARTIAL ${entryTf}] ${symbol}: ${partialCheck.reason}`);
            }

            if (soundTriggered) {
                broadcastSoundAlert(symbol, direction, 'entry');
            }

            // Log signal
            await pushLogEvent(
                symbol,
                direction,
                `${type} ${entryTf} | Entry: ${entry} | SL: ${sl}${godCheck.valid ? ' | GOD ✅' : partialCheck.valid ? ' | PARTIAL ⚠️' : ' | NO ALIGN ❌'}`,
                Date.now()
            );

        } else if (action === "ENTRY_FILLED" || action === "TP_HIT" || action === "SL_HIT") {
            // Log tracking events
            const emoji = action === "TP_HIT" ? "🎯" : action === "SL_HIT" ? "💀" : "📥";
            await pushLogEvent(
                symbol,
                action === "TP_HIT" ? "BULLISH" : action === "SL_HIT" ? "BEARISH" : direction,
                `${emoji} ${action}: ${type} ${entryTf} | Entry: ${entry}`,
                Date.now()
            );
        }

        broadcastAll();
        return res.status(200).send("OK");
    }

    return res.status(400).send("Unknown payload format");
});

// ══════════════════════════════════════════════
// SERVE PAGES
// ══════════════════════════════════════════════
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/stats', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'stats.html'));
});

// ══════════════════════════════════════════════
// START
// ══════════════════════════════════════════════
app.listen(PORT, () => {
    console.log(`\n🚀 God-Mode V3 (Key: ${REDIS_STATE_KEY}) alive on port ${PORT}`);
    console.log(`📊 Alignment Threshold: ${ALIGNMENT_THRESHOLD}/3 (1H + 30M + 15M)`);
    console.log(`📡 Entry TFs: ${ENTRY_TIMEFRAMES.join(', ')}`);
    console.log(`📡 Storyline → ${TELEGRAM_STORYLINE_CHAT_ID}`);
    console.log(`📡 God 5M: ${TG_5M_GOD} | 3M: ${TG_3M_GOD} | 1M: ${TG_1M_GOD}`);
    console.log(`📡 Partial 5M: ${TG_5M_PARTIAL} | 3M: ${TG_3M_PARTIAL} | 1M: ${TG_1M_PARTIAL}`);
});
