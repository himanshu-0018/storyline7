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

const TF_CHANNELS = {
    "1M": {
        god:   process.env.TELEGRAM_1M_GOD_CHAT_ID,
        all:   process.env.TELEGRAM_1M_ALL_CHAT_ID,
        label: "1 Minute"
    },
    "3M": {
        god:   process.env.TELEGRAM_3M_GOD_CHAT_ID,
        all:   process.env.TELEGRAM_3M_ALL_CHAT_ID,
        label: "3 Minutes"
    },
    "5M": {
        god:   process.env.TELEGRAM_5M_GOD_CHAT_ID,
        all:   process.env.TELEGRAM_5M_ALL_CHAT_ID,
        label: "5 Minutes"
    }
};

const GOD_MODE_THRESHOLD = 3;
const ALIGNED_THRESHOLD  = 2;
const REDIS_STATE_KEY    = process.env.REDIS_KEY || 'godModeState';
const REDIS_LOG_KEY      = REDIS_STATE_KEY + '_activityLog';
const REDIS_TRADES_KEY   = REDIS_STATE_KEY + '_trades';

const ZONE_TIMEFRAMES  = ["1H", "30M", "15M"];
const ENTRY_TIMEFRAMES = ["1M", "3M", "5M"];

let marketState  = {};
let activityLog  = [];
let tradeTracker = {};
let clients      = [];

// ══════════════════════════════════════════════
// BROADCAST TO ALL SSE CLIENTS
// ══════════════════════════════════════════════
function broadcastAll() {
    const data = JSON.stringify({ marketState, activityLog, tradeTracker });
    clients.forEach(client => client.res.write(`data: ${data}\n\n`));
}

// ══════════════════════════════════════════════
// TELEGRAM CORE SENDER
// ══════════════════════════════════════════════
async function sendTelegram(chatId, message, context = '') {
    if (!TELEGRAM_TOKEN || !chatId) return;
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
    try {
        const resp = await fetch(url, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({
                chat_id:    chatId,
                text:       message,
                parse_mode: "HTML"
            })
        });
        if (!resp.ok) {
            const err = await resp.text();
            console.error(`Telegram Error [${context}]:`, err);
        }
    } catch (err) {
        console.error(`Telegram Network Error [${context}]:`, err.message);
    }
}

// Convenience wrappers
async function sendStorylineAlert(msg) {
    await sendTelegram(TELEGRAM_STORYLINE_CHAT_ID, msg, 'storyline');
}

async function sendGodModeEntry(tf, msg) {
    await sendTelegram(TF_CHANNELS[tf]?.god, msg, `${tf}-god`);
}

async function sendAlignedEntry(tf, msg) {
    await sendTelegram(TF_CHANNELS[tf]?.all, msg, `${tf}-all`);
}

// ══════════════════════════════════════════════
// ACTIVITY LOG
// ══════════════════════════════════════════════
async function pushLogEvent(symbol, type, message, timestamp = null) {
    const ts = timestamp || Date.now();

    const isDup = activityLog.some(e =>
        e.symbol === symbol &&
        e.type   === type   &&
        Math.abs((e.timestamp || 0) - ts) < 5000
    );
    if (isDup) return;

    activityLog.unshift({ symbol, type, message, timestamp: ts });
    if (activityLog.length > 100) activityLog = activityLog.slice(0, 100);
    await redisClient.set(REDIS_LOG_KEY, JSON.stringify(activityLog));
}

// ══════════════════════════════════════════════
// TRADE TRACKER HELPERS
// ══════════════════════════════════════════════
function getTracker(tf, symbol) {
    if (!tradeTracker[tf]) tradeTracker[tf] = {};
    if (!tradeTracker[tf][symbol]) {
        tradeTracker[tf][symbol] = {
            signals:  0,
            entered:  0,
            tp:       0,
            sl:       0,
            pending:  0,
            active:   0,
            trades:   []
        };
    }
    return tradeTracker[tf][symbol];
}

async function saveTracker() {
    await redisClient.set(REDIS_TRADES_KEY, JSON.stringify(tradeTracker));
}

function recalcTrackerCounts(tracker) {
    let pending = 0, active = 0, entered = 0, tp = 0, sl = 0;

    tracker.trades.forEach(t => {
        if (t.status === 'PENDING')  pending++;
        else if (t.status === 'ACTIVE')  { active++; entered++; }
        else if (t.status === 'TP_HIT')  { tp++;     entered++; }
        else if (t.status === 'SL_HIT')  { sl++;     entered++; }
    });

    tracker.pending  = pending;
    tracker.active   = active;
    tracker.entered  = entered;
    tracker.tp       = tp;
    tracker.sl       = sl;
    tracker.signals  = tracker.trades.length;
}

// ══════════════════════════════════════════════
// MASTER ZONE CALCULATOR
// ══════════════════════════════════════════════
function recalculateMasterZones(symbol) {
    const sym = marketState[symbol];

    if (!sym.stopLosses)                        sym.stopLosses           = { "1H": null, "30M": null, "15M": null };
    if (!sym.breakouts)                         sym.breakouts            = { "1H": null, "30M": null, "15M": null };
    if (sym.activeSL === undefined)             sym.activeSL             = "N/A";
    if (sym.activeBO === undefined)             sym.activeBO             = "N/A";
    if (sym.lastGodModeStartTime === undefined) sym.lastGodModeStartTime = null;
    if (sym.alignmentCount === undefined)       sym.alignmentCount       = 0;

    let bullCount = 0;
    let bearCount = 0;
    const currentTfs = sym.timeframes || {};

    ZONE_TIMEFRAMES.forEach(tf => {
        if (currentTfs[tf] === "BULLISH") bullCount++;
        if (currentTfs[tf] === "BEARISH") bearCount++;
    });

    let dominantState  = "NONE";
    let alignmentLevel = 0;

    if (bullCount >= ALIGNED_THRESHOLD) {
        dominantState  = "BULLISH";
        alignmentLevel = bullCount;
    }
    if (bearCount >= ALIGNED_THRESHOLD) {
        dominantState  = "BEARISH";
        alignmentLevel = bearCount;
    }

    sym.alignmentCount = alignmentLevel;

    // Zone calculated for display (not gating)
    let masterBO = "N/A";
    let masterSL = "N/A";

    if (dominantState !== "NONE") {
        const validBOs = [];
        const validSLs = [];

        ZONE_TIMEFRAMES.forEach(tf => {
            if (currentTfs[tf] === dominantState) {
                const tfBo = sym.breakouts[tf];
                const tfSl = sym.stopLosses[tf];
                if (tfBo != null && tfBo !== "N/A" && tfSl != null && tfSl !== "N/A") {
                    validBOs.push(parseFloat(tfBo));
                    validSLs.push(parseFloat(tfSl));
                }
            }
        });

        if (validBOs.length > 0 && validSLs.length > 0) {
            masterBO = dominantState === "BULLISH" ? Math.max(...validBOs) : Math.min(...validBOs);
            masterSL = dominantState === "BULLISH" ? Math.max(...validSLs) : Math.min(...validSLs);
        }
    }

    sym.activeBO = masterBO;
    sym.activeSL = masterSL;

    return { dominantState, bullCount, bearCount, alignmentLevel, masterBO, masterSL };
}

// ══════════════════════════════════════════════
// ENTRY VALIDATORS — ALIGNMENT ONLY, NO ZONE
// ══════════════════════════════════════════════
function validateGodModeEntry(symbol, signalDirection) {
    if (!marketState[symbol]) return { valid: false, reason: "Symbol not tracked" };

    const data           = marketState[symbol];
    const godState       = data.lastAlertedState;
    const alignmentCount = data.alignmentCount || 0;

    if (godState === "NONE" || alignmentCount < GOD_MODE_THRESHOLD)
        return { valid: false, reason: `Not God-Mode (${alignmentCount}/3)` };

    if (signalDirection !== godState)
        return { valid: false, reason: `Direction mismatch: Signal=${signalDirection}, God=${godState}` };

    return {
        valid:          true,
        reason:         "3/3 alignment confirmed",
        godState,
        alignmentCount
    };
}

function validateAlignedEntry(symbol, signalDirection) {
    if (!marketState[symbol]) return { valid: false, reason: "Symbol not tracked" };

    const data           = marketState[symbol];
    const godState       = data.lastAlertedState;
    const alignmentCount = data.alignmentCount || 0;

    if (godState === "NONE" || alignmentCount < ALIGNED_THRESHOLD)
        return { valid: false, reason: `Not aligned (${alignmentCount}/3)` };

    if (signalDirection !== godState)
        return { valid: false, reason: `Direction mismatch` };

    return {
        valid:          true,
        reason:         `${alignmentCount}/3 alignment confirmed`,
        godState,
        alignmentCount
    };
}

// ══════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════
function getAlignedTFs(symbol, direction) {
    if (!marketState[symbol]?.timeframes) return "N/A";
    return ZONE_TIMEFRAMES.filter(t => marketState[symbol].timeframes[t] === direction).join(' + ') || "None";
}

function getZoneDisplay(symbol) {
    if (!marketState[symbol]) return { bo: "N/A", sl: "N/A" };
    return {
        bo: marketState[symbol].activeBO || "N/A",
        sl: marketState[symbol].activeSL || "N/A"
    };
}

// ══════════════════════════════════════════════
// REDIS BOOT
// ══════════════════════════════════════════════
const redisClient = createClient({ url: process.env.REDIS_URL });
redisClient.on('error', err => console.error('Redis Client Error:', err));
await redisClient.connect();
console.log('✅ Connected to Redis');

// Restore market state
const savedData = await redisClient.get(REDIS_STATE_KEY);
if (savedData) {
    marketState = JSON.parse(savedData);
    console.log(`💾 Restored state from: ${REDIS_STATE_KEY}`);

    for (const symbol in marketState) {
        // Clean obsolete timeframes
        ["1D", "4H", "1W", "1M"].forEach(tf => {
            if (marketState[symbol].timeframes) delete marketState[symbol].timeframes[tf];
            if (marketState[symbol].breakouts)  delete marketState[symbol].breakouts[tf];
            if (marketState[symbol].stopLosses) delete marketState[symbol].stopLosses[tf];
        });

        // Ensure new timeframes exist
        if (!marketState[symbol].timeframes) marketState[symbol].timeframes = {};
        if (!marketState[symbol].breakouts)  marketState[symbol].breakouts  = {};
        if (!marketState[symbol].stopLosses) marketState[symbol].stopLosses = {};

        ZONE_TIMEFRAMES.forEach(tf => {
            if (!marketState[symbol].timeframes[tf])              marketState[symbol].timeframes[tf] = "NONE";
            if (marketState[symbol].breakouts[tf]  === undefined) marketState[symbol].breakouts[tf]  = null;
            if (marketState[symbol].stopLosses[tf] === undefined) marketState[symbol].stopLosses[tf] = null;
        });

        const { dominantState, alignmentLevel } = recalculateMasterZones(symbol);

        if (dominantState !== "NONE") {
            if (marketState[symbol].lastAlertedState !== dominantState) {
                console.log(`🔄 [BOOT] ${symbol}: "${marketState[symbol].lastAlertedState}" → "${dominantState}" (${alignmentLevel}/3)`);
                marketState[symbol].lastAlertedState = dominantState;
                if (!marketState[symbol].lastGodModeStartTime) {
                    marketState[symbol].lastGodModeStartTime = Date.now();
                }
            }
        } else {
            if (marketState[symbol].lastAlertedState !== "NONE") {
                console.log(`🔄 [BOOT] ${symbol}: "${marketState[symbol].lastAlertedState}" → "NONE"`);
                marketState[symbol].lastAlertedState = "NONE";
            }
            marketState[symbol].activeBO = "N/A";
            marketState[symbol].activeSL = "N/A";
        }
    }

    await redisClient.set(REDIS_STATE_KEY, JSON.stringify(marketState));
    console.log(`🔄 Re-synced ${Object.keys(marketState).length} symbols`);
} else {
    console.log(`🆕 No saved state found for: ${REDIS_STATE_KEY}`);
}

// Restore activity log
const savedLog = await redisClient.get(REDIS_LOG_KEY);
if (savedLog) {
    activityLog = JSON.parse(savedLog);
    console.log(`📋 Restored ${activityLog.length} log entries`);
} else {
    console.log(`📋 No activity log found`);
}

// Restore trade tracker
const savedTrades = await redisClient.get(REDIS_TRADES_KEY);
if (savedTrades) {
    tradeTracker = JSON.parse(savedTrades);
    console.log(`📊 Restored trade tracker data`);
} else {
    console.log(`📊 No trade data found`);
}

// Clean legacy key
await redisClient.del((process.env.REDIS_KEY || 'godModeState') + '_lastEntry');

// ══════════════════════════════════════════════
// API ENDPOINTS
// ══════════════════════════════════════════════
app.get('/api/state', (req, res) => {
    res.json({ marketState, activityLog, tradeTracker });
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

// ── DELETE ENDPOINT ──
app.post('/api/delete', async (req, res) => {
    const { symbol, action } = req.body;
    if (!symbol || action !== 'DELETE') return res.status(400).send("Invalid Delete Payload");

    const sym = symbol.toUpperCase().trim();
    console.log(`\n[PURGE] Received purge request for: ${sym}`);

    if (marketState[sym]) {
        delete marketState[sym];

        // Also clean trade tracker for this symbol across all TFs
        ENTRY_TIMEFRAMES.forEach(tf => {
            if (tradeTracker[tf] && tradeTracker[tf][sym]) {
                delete tradeTracker[tf][sym];
            }
        });

        await redisClient.set(REDIS_STATE_KEY, JSON.stringify(marketState));
        await saveTracker();
        console.log(`✅ [PURGE] ${sym} successfully deleted.`);
        await pushLogEvent(sym, 'NONE', `🗑️ Manually Purged from Database`, Date.now());
        broadcastAll();
        return res.status(200).send("Purged successfully");
    } else {
        console.log(`❌ [PURGE] ${sym} not found.`);
        return res.status(404).send("Symbol not found");
    }
});

// ── RESET TRADES ENDPOINT ──
app.post('/api/reset-trades', async (req, res) => {
    const { tf, symbol } = req.body;

    if (tf && symbol) {
        const sym = symbol.toUpperCase().trim();
        if (tradeTracker[tf] && tradeTracker[tf][sym]) {
            tradeTracker[tf][sym] = { signals: 0, entered: 0, tp: 0, sl: 0, pending: 0, active: 0, trades: [] };
            console.log(`🔄 Reset trades for ${sym} on ${tf}`);
        }
    } else if (tf) {
        tradeTracker[tf] = {};
        console.log(`🔄 Reset all trades for ${tf}`);
    } else {
        tradeTracker = {};
        console.log(`🔄 Reset ALL trade data`);
    }

    await saveTracker();
    broadcastAll();
    return res.status(200).send("OK");
});

// ── CHANNEL CONFIG ENDPOINT ──
app.get('/api/channels', (req, res) => {
    const config = {};
    ENTRY_TIMEFRAMES.forEach(tf => {
        config[tf] = {
            godConfigured: !!TF_CHANNELS[tf]?.god,
            allConfigured: !!TF_CHANNELS[tf]?.all,
            label:         TF_CHANNELS[tf]?.label || tf
        };
    });
    res.json({
        channels:            config,
        storylineConfigured: !!TELEGRAM_STORYLINE_CHAT_ID
    });
});

// ══════════════════════════════════════════════
// UNIFIED WEBHOOK
// ══════════════════════════════════════════════
app.post('/webhook', async (req, res) => {
    const payload = req.body;

    const isStoryline = payload.state !== undefined && payload.tf !== undefined && !payload.type;
    const isEntry     = payload.type  !== undefined;

    // ─────────────────────────────────────────
    // STORYLINE WEBHOOK (1H / 30M / 15M)
    // ─────────────────────────────────────────
    if (isStoryline) {
        const { symbol, tf, state, bo, sl } = payload;
        if (!symbol || !tf || !state) return res.status(400).send("Invalid Storyline Payload");

        // Only accept storyline TFs
        if (!ZONE_TIMEFRAMES.includes(tf)) {
            console.log(`[STORYLINE] ${symbol} | ${tf} ignored — only 1H/30M/15M tracked`);
            return res.status(200).send("OK");
        }

        console.log(`\n[STORYLINE] ${symbol} | ${tf} → ${state} | BO: ${bo || 'N/A'} | SL: ${sl || 'N/A'}`);

        // Initialize symbol if new
        if (!marketState[symbol]) {
            marketState[symbol] = {
                timeframes:           { "1H": "NONE", "30M": "NONE", "15M": "NONE" },
                breakouts:            { "1H": null,   "30M": null,   "15M": null   },
                stopLosses:           { "1H": null,   "30M": null,   "15M": null   },
                lastAlertedState:     "NONE",
                activeBO:             "N/A",
                activeSL:             "N/A",
                alignmentCount:       0,
                lastGodModeStartTime: null
            };
        }

        // Remove obsolete TFs
        ["1D", "4H", "1W", "1M"].forEach(oldTf => {
            if (marketState[symbol].timeframes) delete marketState[symbol].timeframes[oldTf];
            if (marketState[symbol].breakouts)  delete marketState[symbol].breakouts[oldTf];
            if (marketState[symbol].stopLosses) delete marketState[symbol].stopLosses[oldTf];
        });

        // Update the timeframe
        marketState[symbol].timeframes[tf] = state;
        if (bo !== undefined) marketState[symbol].breakouts[tf]  = bo;
        if (sl !== undefined) marketState[symbol].stopLosses[tf] = sl;

        // Recalculate alignment
        const prevAlertedState   = marketState[symbol].lastAlertedState;
        const prevAlignmentCount = marketState[symbol].alignmentCount || 0;
        const { dominantState, bullCount, bearCount, alignmentLevel, masterBO, masterSL } = recalculateMasterZones(symbol);

        console.log(`[ZONE] ${symbol} → ${dominantState} | 🐂 ${bullCount}/3 | 🐻 ${bearCount}/3 | Align: ${alignmentLevel}/3 | BO: ${masterBO} | SL: ${masterSL}`);

        const getAlignLabel = (n) => n >= 3 ? "GOD MODE" : n >= 2 ? "ALIGNED" : "NONE";

        const buildAlignedTFs = (dir) => ZONE_TIMEFRAMES
            .filter(t => marketState[symbol].timeframes[t] === dir).join(' + ');

        // ── Alignment ON or UPGRADED ──
        if (dominantState !== "NONE" &&
            (dominantState !== prevAlertedState || alignmentLevel !== prevAlignmentCount)) {

            const now = Date.now();

            if (prevAlertedState === "NONE" || dominantState !== prevAlertedState) {
                marketState[symbol].lastGodModeStartTime = now;
            }

            marketState[symbol].lastAlertedState = dominantState;
            const alignedTFs = buildAlignedTFs(dominantState);

            if (alignmentLevel >= GOD_MODE_THRESHOLD) {
                // 3/3 = GOD MODE
                const emoji = dominantState === "BULLISH" ? "🚀 🐂" : "🩸 🐻";
                let msg  = `<b>${emoji} GOD-MODE: ${symbol}</b>\n\n`;
                msg += `<b>Trend:</b> ${dominantState} (${alignmentLevel}/3)\n`;
                msg += `<b>🎯 Zone:</b> <code>${masterBO}</code> → <code>${masterSL}</code>\n`;
                msg += `<b>Aligned:</b> ${alignedTFs} ✅\n`;
                msg += `<b>Status:</b> ⚡ GOD MODE ACTIVE`;
                await sendStorylineAlert(msg);
                await pushLogEvent(symbol, dominantState,
                    `⚡ GOD MODE: ${dominantState} | ${alignedTFs} | Zone: ${masterBO} → ${masterSL}`, now);
                console.log(`[GOD ON] ${symbol} → ${dominantState} 3/3`);

            } else {
                // 2/3 = ALIGNED
                const emoji = dominantState === "BULLISH" ? "📈 🐂" : "📉 🐻";
                let msg  = `<b>${emoji} ALIGNED: ${symbol}</b>\n\n`;
                msg += `<b>Trend:</b> ${dominantState} (${alignmentLevel}/3)\n`;
                msg += `<b>🎯 Zone:</b> <code>${masterBO}</code> → <code>${masterSL}</code>\n`;
                msg += `<b>Aligned:</b> ${alignedTFs} ✅\n`;
                msg += `<b>Status:</b> 🔶 ALIGNED (need 1 more for God Mode)`;
                await sendStorylineAlert(msg);
                await pushLogEvent(symbol, dominantState,
                    `🔶 Aligned: ${dominantState} | ${alignedTFs} | Zone: ${masterBO} → ${masterSL}`, now);
                console.log(`[ALIGNED] ${symbol} → ${dominantState} ${alignmentLevel}/3`);
            }

        // ── DOWNGRADE (3→2) ──
        } else if (dominantState !== "NONE" && dominantState === prevAlertedState &&
                   alignmentLevel < prevAlignmentCount && alignmentLevel >= ALIGNED_THRESHOLD) {

            const alignedTFs = buildAlignedTFs(dominantState);
            let msg = `<b>⚠️ DOWNGRADED: ${symbol}</b>\n\n`;
            msg += `<b>Was:</b> ${getAlignLabel(prevAlignmentCount)} (${prevAlignmentCount}/3)\n`;
            msg += `<b>Now:</b> ${getAlignLabel(alignmentLevel)} (${alignmentLevel}/3)\n`;
            msg += `<b>Still aligned:</b> ${alignedTFs}\n`;
            msg += `<b>Zone:</b> <code>${masterBO}</code> → <code>${masterSL}</code>`;
            await sendStorylineAlert(msg);
            await pushLogEvent(symbol, dominantState,
                `⚠️ Downgraded: ${getAlignLabel(prevAlignmentCount)} → ${getAlignLabel(alignmentLevel)} (${alignmentLevel}/3)`,
                Date.now());
            console.log(`[DOWNGRADE] ${symbol} ${prevAlignmentCount}/3 → ${alignmentLevel}/3`);

        // ── Alignment LOST ──
        } else if (dominantState === "NONE" && prevAlertedState !== "NONE") {
            const prevDir = prevAlertedState;
            marketState[symbol].lastAlertedState  = "NONE";
            marketState[symbol].activeBO          = "N/A";
            marketState[symbol].activeSL          = "N/A";
            marketState[symbol].alignmentCount    = 0;

            let msg = `<b>⚠️ TREND LOST: ${symbol}</b>\n\n`;
            msg += `<b>Was:</b> ${prevDir} (${getAlignLabel(prevAlignmentCount)})\n`;
            msg += `Alignment dropped below 2/3.`;
            await sendStorylineAlert(msg);
            await pushLogEvent(symbol, 'NONE',
                `Trend Lost: ${prevDir} | ${prevAlignmentCount}/3 → 0/3`, Date.now());
            console.log(`[TREND LOST] ${symbol} → NONE`);
        }

        await redisClient.set(REDIS_STATE_KEY, JSON.stringify(marketState));
        broadcastAll();
        return res.status(200).send("OK");
    }

    // ─────────────────────────────────────────
    // ENTRY SIGNAL WEBHOOK (1M / 3M / 5M)
    // Actions: SIGNAL, ENTRY_FILLED, TP_HIT, SL_HIT
    //
    // SIGNAL → Telegram (God/Aligned routing)
    // ENTRY_FILLED / TP_HIT / SL_HIT → Stats only (NO Telegram)
    // ─────────────────────────────────────────
    if (isEntry) {
        const { symbol, type, direction, entry, sl, tp, rr, tf, touched_level, action } = payload;

        if (!symbol || !type || !direction || entry === undefined || sl === undefined) {
            return res.status(400).send("Invalid Entry Payload");
        }

        // Validate TF
        const entryTF  = tf ? tf.toUpperCase() : null;
        const tfConfig = entryTF ? TF_CHANNELS[entryTF] : null;

        if (!entryTF || !tfConfig) {
            console.log(`[ENTRY] ${symbol} | Unknown TF: "${tf}" | Accepted: ${ENTRY_TIMEFRAMES.join(', ')}`);
            return res.status(400).send(`Invalid entry TF: "${tf}". Must be one of: ${ENTRY_TIMEFRAMES.join(', ')}`);
        }

        const entryAction = (action || "SIGNAL").toUpperCase();
        const tracker     = getTracker(entryTF, symbol);
        const rrVal       = rr || 5;
        const tpVal       = tp || (direction === "BULLISH"
            ? parseFloat(entry) + Math.abs(parseFloat(entry) - parseFloat(sl)) * rrVal
            : parseFloat(entry) - Math.abs(parseFloat(entry) - parseFloat(sl)) * rrVal);

        console.log(`\n[${entryAction} ${entryTF}] ${symbol} | ${type} | ${direction} | Entry: ${entry} | SL: ${sl} | TP: ${tpVal}`);

        // ══════════════════════════════════════
        // ACTION: SIGNAL — new pattern detected
        // Trade starts as PENDING (waiting for entry fill)
        // Sent to Telegram for God/Aligned routing
        // ══════════════════════════════════════
        if (entryAction === "SIGNAL") {

            // Store trade as PENDING
            tracker.trades.push({
                entry:         parseFloat(entry),
                sl:            parseFloat(sl),
                tp:            parseFloat(tpVal),
                rr:            rrVal,
                direction,
                type,
                touched_level: touched_level || "N/A",
                status:        "PENDING",
                timestamp:     Date.now()
            });

            // Trim old trades (keep last 100)
            if (tracker.trades.length > 100) tracker.trades = tracker.trades.slice(-100);
            recalcTrackerCounts(tracker);

            // ── Telegram: SIGNAL only ──
            const emoji      = direction === "BULLISH" ? "🟢 🐂" : "🔴 🐻";
            const alignedTFs = getAlignedTFs(symbol, direction);
            const zone       = getZoneDisplay(symbol);

            // God Mode channel (3/3)
            const godValidation = validateGodModeEntry(symbol, direction);
            if (godValidation.valid) {
                console.log(`✅ [GOD ${entryTF}] ${symbol} | ${direction} | ${godValidation.alignmentCount}/3`);

                let msg  = `<b>${emoji} ⚡ GOD SIGNAL [${entryTF}]: ${symbol}</b>\n\n`;
                msg += `<b>Timeframe:</b> ${tfConfig.label} (${entryTF})\n`;
                msg += `<b>Type:</b> ${type}\n`;
                msg += `<b>Direction:</b> ${direction}\n`;
                msg += `<b>Entry:</b> <code>${entry}</code>\n`;
                msg += `<b>SL:</b> <code>${sl}</code>\n`;
                msg += `<b>TP (${rrVal}R):</b> <code>${tpVal}</code>\n`;
                msg += `<b>Level:</b> ${touched_level || "N/A"}\n`;
                msg += `\n<b>Storyline:</b> ✅ ${godValidation.godState} (${godValidation.alignmentCount}/3)\n`;
                msg += `<b>Aligned:</b> ${alignedTFs}\n`;
                msg += `<b>Ref Zone:</b> <code>${zone.bo}</code> → <code>${zone.sl}</code>\n`;
                msg += `<b>Status:</b> ⚡ GOD MODE`;

                await sendGodModeEntry(entryTF, msg);
            } else {
                console.log(`❌ [GOD ${entryTF} REJECTED] ${symbol} | ${godValidation.reason}`);
            }

            // Aligned channel (2/3)
            const alignValidation = validateAlignedEntry(symbol, direction);
            if (alignValidation.valid) {
                const isGodMode = alignValidation.alignmentCount >= GOD_MODE_THRESHOLD;
                const statusTag = isGodMode ? "⚡ GOD MODE" : "🔶 ALIGNED";

                console.log(`✅ [ALIGNED ${entryTF}] ${symbol} | ${direction} | ${alignValidation.alignmentCount}/3`);

                let msg  = `<b>${emoji} ALIGNED SIGNAL [${entryTF}]: ${symbol}</b>\n\n`;
                msg += `<b>Timeframe:</b> ${tfConfig.label} (${entryTF})\n`;
                msg += `<b>Type:</b> ${type}\n`;
                msg += `<b>Direction:</b> ${direction}\n`;
                msg += `<b>Entry:</b> <code>${entry}</code>\n`;
                msg += `<b>SL:</b> <code>${sl}</code>\n`;
                msg += `<b>TP (${rrVal}R):</b> <code>${tpVal}</code>\n`;
                msg += `<b>Level:</b> ${touched_level || "N/A"}\n`;
                msg += `\n<b>Storyline:</b> ✅ ${alignValidation.godState} (${alignValidation.alignmentCount}/3)\n`;
                msg += `<b>Aligned:</b> ${alignedTFs}\n`;
                msg += `<b>Ref Zone:</b> <code>${zone.bo}</code> → <code>${zone.sl}</code>\n`;
                msg += `<b>Status:</b> ${statusTag}`;

                await sendAlignedEntry(entryTF, msg);
            } else {
                console.log(`❌ [ALIGNED ${entryTF} REJECTED] ${symbol} | ${alignValidation.reason}`);
            }

        // ══════════════════════════════════════
        // ACTION: ENTRY_FILLED — price came back to entry
        // Stats only, NO Telegram
        // ══════════════════════════════════════
        } else if (entryAction === "ENTRY_FILLED") {
            const trade = tracker.trades.find(t =>
                t.status === "PENDING" &&
                Math.abs(t.entry - parseFloat(entry)) < 0.0001 &&
                t.direction === direction
            );
            if (trade) {
                trade.status = "ACTIVE";
                console.log(`📥 [ENTRY FILLED ${entryTF}] ${symbol} | ${direction} | Entry: ${entry}`);
            } else {
                console.log(`⚠️ [ENTRY FILLED ${entryTF}] ${symbol} | No matching PENDING trade found`);
            }
            recalcTrackerCounts(tracker);

        // ══════════════════════════════════════
        // ACTION: TP_HIT — take profit reached
        // Entry always filled before TP (guaranteed)
        // Can come on same candle as ENTRY_FILLED
        // Stats only, NO Telegram
        // ══════════════════════════════════════
        } else if (entryAction === "TP_HIT") {
            // Find ACTIVE trade first, then PENDING (same-candle entry+TP)
            const trade = tracker.trades.find(t =>
                (t.status === "ACTIVE" || t.status === "PENDING") &&
                Math.abs(t.entry - parseFloat(entry)) < 0.0001 &&
                t.direction === direction
            );
            if (trade) {
                trade.status = "TP_HIT";
                console.log(`✅ [TP HIT ${entryTF}] ${symbol} | ${direction} | Entry: ${entry} | TP: ${tpVal}`);
            } else {
                console.log(`⚠️ [TP HIT ${entryTF}] ${symbol} | No matching trade found`);
            }
            recalcTrackerCounts(tracker);

        // ══════════════════════════════════════
        // ACTION: SL_HIT — stop loss reached
        // Entry always filled before SL (guaranteed)
        // Can come on same candle as ENTRY_FILLED
        // Stats only, NO Telegram
        // ══════════════════════════════════════
        } else if (entryAction === "SL_HIT") {
            const trade = tracker.trades.find(t =>
                (t.status === "ACTIVE" || t.status === "PENDING") &&
                Math.abs(t.entry - parseFloat(entry)) < 0.0001 &&
                t.direction === direction
            );
            if (trade) {
                trade.status = "SL_HIT";
                console.log(`❌ [SL HIT ${entryTF}] ${symbol} | ${direction} | Entry: ${entry} | SL: ${sl}`);
            } else {
                console.log(`⚠️ [SL HIT ${entryTF}] ${symbol} | No matching trade found`);
            }
            recalcTrackerCounts(tracker);
        }

        await saveTracker();
        broadcastAll();
        return res.status(200).send("OK");
    }

    return res.status(400).send("Unknown payload format");
});

// ══════════════════════════════════════════════
// START SERVER
// ══════════════════════════════════════════════
app.listen(PORT, () => {
    console.log(`\n🚀 God-Mode V3.5 (Key: ${REDIS_STATE_KEY}) on port ${PORT}`);
    console.log(`\n📐 STORYLINE TIMEFRAMES: ${ZONE_TIMEFRAMES.join(' + ')}`);
    console.log(`📐 ENTRY TIMEFRAMES:     ${ENTRY_TIMEFRAMES.join(' + ')}`);
    console.log(`\n📊 God Mode Threshold:  ${GOD_MODE_THRESHOLD}/3`);
    console.log(`📊 Aligned Threshold:   ${ALIGNED_THRESHOLD}/3`);
    console.log(`\n📡 Storyline Alerts → ${TELEGRAM_STORYLINE_CHAT_ID || '❌ NOT SET'}`);
    console.log(`\n📡 Entry Channels:`);
    ENTRY_TIMEFRAMES.forEach(tf => {
        const ch = TF_CHANNELS[tf];
        console.log(`   ${tf}: GOD → ${ch?.god || '❌ NOT SET'} | ALL → ${ch?.all || '❌ NOT SET'}`);
    });
    console.log(`\n📡 SIGNAL → Telegram | ENTRY_FILLED / TP_HIT / SL_HIT → Stats only (webpage)`);
});
