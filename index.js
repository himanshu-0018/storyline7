import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from 'redis';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT                       = process.env.PORT || 3000;
const TELEGRAM_TOKEN             = process.env.TELEGRAM_TOKEN;
const TELEGRAM_STORYLINE_CHAT_ID = process.env.TELEGRAM_STORYLINE_CHAT_ID;
const TG_5M_GOD                  = process.env.TG_5M_GOD;
const TG_3M_GOD                  = process.env.TG_3M_GOD;
const TG_1M_GOD                  = process.env.TG_1M_GOD;
const TG_5M_PARTIAL              = process.env.TG_5M_PARTIAL;
const TG_3M_PARTIAL              = process.env.TG_3M_PARTIAL;
const TG_1M_PARTIAL              = process.env.TG_1M_PARTIAL;

const ALIGNMENT_THRESHOLD = 3;
const REDIS_STATE_KEY     = process.env.REDIS_KEY || 'godModeState_v3';
const REDIS_LOG_KEY       = REDIS_STATE_KEY + '_activityLog';
const REDIS_STATS_KEY     = REDIS_STATE_KEY + '_tradeStats';
const ZONE_TIMEFRAMES     = ["1H", "30M", "15M"];
const ENTRY_TIMEFRAMES    = ["5M", "3M", "1M"];

let marketState = {};
let activityLog = [];
let tradeStats  = {};
let clients     = [];
let statsClients = [];

// ══════════════════════════════════════════════
// BROADCAST
// ══════════════════════════════════════════════
function broadcastAll(extras = {}) {
    const data = JSON.stringify({ marketState, activityLog, ...extras });
    clients.forEach(c => c.res.write(`data: ${data}\n\n`));
}
function broadcastSoundAlert(symbol, direction) {
    const data = JSON.stringify({ soundAlert: true, symbol, direction });
    clients.forEach(c => c.res.write(`data: ${data}\n\n`));
}
function broadcastStats() {
    const enriched = buildEnrichedStats();
    const data = JSON.stringify({ tradeStats: enriched });
    statsClients.forEach(c => c.res.write(`data: ${data}\n\n`));
}

// ══════════════════════════════════════════════
// TELEGRAM
// ══════════════════════════════════════════════
async function sendTelegram(chatId, message) {
    if (!TELEGRAM_TOKEN || !chatId) return false;
    try {
        const resp = await fetch(
            `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
            {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ chat_id: chatId, text: message, parse_mode: "HTML" })
            }
        );
        return resp.ok;
    } catch (err) {
        console.error("Telegram Error:", err);
        return false;
    }
}
function getGodChannel(tf)     { return { "5M": TG_5M_GOD,     "3M": TG_3M_GOD,     "1M": TG_1M_GOD     }[tf] || null; }
function getPartialChannel(tf) { return { "5M": TG_5M_PARTIAL, "3M": TG_3M_PARTIAL, "1M": TG_1M_PARTIAL }[tf] || null; }

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
// PRICE MATCH
// ══════════════════════════════════════════════
function priceMatch(a, b) {
    const fa = parseFloat(a);
    const fb = parseFloat(b);
    if (isNaN(fa) || isNaN(fb)) return false;
    const tolerance = Math.max(Math.abs(fa), Math.abs(fb)) * 0.0005;
    return Math.abs(fa - fb) <= tolerance;
}

function makeTradeId(symbol, tf) {
    return `${symbol}_${tf}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

// ══════════════════════════════════════════════
// STATS HELPERS
// ══════════════════════════════════════════════
function ensureStats(symbol, tf) {
    if (!tradeStats[symbol])     tradeStats[symbol]     = {};
    if (!tradeStats[symbol][tf]) tradeStats[symbol][tf] = {
        total_signals: 0,
        trades:        []
    };
    return tradeStats[symbol][tf];
}

function getLiveCounts(stats) {
    let pending = 0, active = 0, tp = 0, sl = 0, entries = 0;
    let god_tp = 0, god_sl = 0, god_signals = 0;
    let partial_tp = 0, partial_sl = 0, partial_signals = 0;
    let none_tp = 0, none_sl = 0, none_signals = 0;

    for (const t of stats.trades) {
        const align = t.alignment || 'NONE';

        if (t.status === 'SIGNAL')  pending++;
        if (t.status === 'ACTIVE')  { active++; entries++; }
        if (t.status === 'TP_HIT') { tp++; entries++; }
        if (t.status === 'SL_HIT') { sl++; entries++; }

        if (align === 'GOD') {
            god_signals++;
            if (t.status === 'TP_HIT') god_tp++;
            if (t.status === 'SL_HIT') god_sl++;
        } else if (align === 'PARTIAL') {
            partial_signals++;
            if (t.status === 'TP_HIT') partial_tp++;
            if (t.status === 'SL_HIT') partial_sl++;
        } else {
            none_signals++;
            if (t.status === 'TP_HIT') none_tp++;
            if (t.status === 'SL_HIT') none_sl++;
        }
    }
    return {
        pending, active, tp_hits: tp, sl_hits: sl, total_entries: entries,
        god_tp, god_sl, god_signals,
        partial_tp, partial_sl, partial_signals,
        none_tp, none_sl, none_signals
    };
}

function buildEnrichedStats() {
    const enriched = {};
    for (const sym in tradeStats) {
        enriched[sym] = {};
        for (const tf in tradeStats[sym]) {
            const s      = tradeStats[sym][tf];
            const counts = getLiveCounts(s);
            enriched[sym][tf] = {
                total_signals: s.total_signals || 0,
                total_entries: counts.total_entries,
                tp_hits:       counts.tp_hits,
                sl_hits:       counts.sl_hits,
                pending:       counts.pending,
                active:        counts.active,
                god_tp:        counts.god_tp,
                god_sl:        counts.god_sl,
                god_signals:   counts.god_signals,
                partial_tp:    counts.partial_tp,
                partial_sl:    counts.partial_sl,
                partial_signals: counts.partial_signals,
                none_tp:       counts.none_tp,
                none_sl:       counts.none_sl,
                none_signals:  counts.none_signals,
                trades:        s.trades
            };
        }
    }
    return enriched;
}

async function saveStats() {
    await redisClient.set(REDIS_STATS_KEY, JSON.stringify(tradeStats));
}

// ══════════════════════════════════════════════
// MULTI-POSITION TRADE FINDER (FIFO)
// ══════════════════════════════════════════════
function findBestTrade(stats, { tradeId, direction, entry, allowedStatuses }) {
    const trades = stats.trades;

    if (tradeId) {
        const idx = trades.findIndex(t => t.id === tradeId);
        if (idx !== -1) return { trade: trades[idx], index: idx };
    }

    const candidates = [];

    if (entry !== undefined && entry !== null) {
        for (let i = 0; i < trades.length; i++) {
            const t = trades[i];
            if (t.direction === direction && allowedStatuses.includes(t.status) && priceMatch(t.entry, entry)) {
                candidates.push({ trade: t, index: i });
            }
        }
    }

    if (candidates.length === 0 && entry !== undefined && entry !== null) {
        for (let i = 0; i < trades.length; i++) {
            const t = trades[i];
            if (t.direction === direction && priceMatch(t.entry, entry) && ['SIGNAL', 'ACTIVE'].includes(t.status)) {
                candidates.push({ trade: t, index: i });
            }
        }
    }

    if (candidates.length === 0) {
        for (let i = 0; i < trades.length; i++) {
            const t = trades[i];
            if (t.direction === direction && allowedStatuses.includes(t.status)) {
                candidates.push({ trade: t, index: i });
            }
        }
    }

    if (candidates.length === 0) return null;
    candidates.sort((a, b) => a.index - b.index);
    return candidates[0];
}

// ══════════════════════════════════════════════
// GET CURRENT ALIGNMENT FOR A SYMBOL
// ══════════════════════════════════════════════
function getCurrentAlignment(symbol, direction) {
    if (!marketState[symbol]) return 'NONE';
    const godState = marketState[symbol].lastAlertedState;
    if (godState !== 'NONE' && godState === direction) return 'GOD';

    const tfs = marketState[symbol].timeframes || {};
    let count = 0;
    ZONE_TIMEFRAMES.forEach(tf => { if (tfs[tf] === direction) count++; });
    if (count >= 2) return 'PARTIAL';
    return 'NONE';
}

// ══════════════════════════════════════════════
// RECORD FUNCTIONS
// ══════════════════════════════════════════════

async function recordSignal(symbol, tf, direction, entry, sl, tp, rr, touchedLevel) {
    const stats = ensureStats(symbol, tf);
    stats.total_signals++;

    const alignment = getCurrentAlignment(symbol, direction);

    const trade = {
        id:            makeTradeId(symbol, tf),
        direction,
        entry:         parseFloat(entry)  || entry,
        sl:            parseFloat(sl)     || sl,
        tp:            parseFloat(tp)     || tp,
        rr:            parseFloat(rr)     || rr,
        touched_level: touchedLevel || '',
        channel:       'PENDING',
        alignment:     alignment,
        status:        'SIGNAL',
        signal_time:   Date.now(),
        entry_time:    null,
        result_time:   null
    };
    stats.trades.push(trade);
    if (stats.trades.length > 500) stats.trades = stats.trades.slice(-500);

    console.log(`  [STATS] Signal: ID=${trade.id} | ${symbol} ${tf} ${direction} @ ${entry} | Align: ${alignment}`);
    await saveStats();
    broadcastStats();
    return trade.id;
}

async function recordEntryFilled(symbol, tf, direction, entry) {
    const stats = ensureStats(symbol, tf);

    const found = findBestTrade(stats, {
        direction,
        entry,
        allowedStatuses: ['SIGNAL']
    });

    if (found) {
        found.trade.status     = 'ACTIVE';
        found.trade.entry_time = Date.now();
        console.log(`  [STATS] Filled: ID=${found.trade.id} | ${symbol} ${tf} ${direction} @ ${entry}`);
    } else {
        const alignment = getCurrentAlignment(symbol, direction);
        console.warn(`  [STATS] Orphan ENTRY_FILLED: ${symbol} ${tf} ${direction} @ ${entry}`);
        stats.trades.push({
            id:           makeTradeId(symbol, tf),
            direction,
            entry:        parseFloat(entry) || entry,
            sl: null, tp: null, rr: null,
            channel:      'UNKNOWN',
            alignment:    alignment,
            status:       'ACTIVE',
            signal_time:  null,
            entry_time:   Date.now(),
            result_time:  null
        });
    }
    await saveStats();
    broadcastStats();
}

async function recordResult(symbol, tf, direction, entry, action) {
    const stats  = ensureStats(symbol, tf);

    const found = findBestTrade(stats, {
        direction,
        entry,
        allowedStatuses: ['ACTIVE', 'SIGNAL']
    });

    if (found) {
        const wasSameCandleFill = found.trade.status === 'SIGNAL';
        found.trade.status      = action;
        found.trade.result_time = Date.now();
        if (wasSameCandleFill) found.trade.entry_time = Date.now();
        console.log(`  [STATS] ${action}: ID=${found.trade.id} | ${symbol} ${tf} ${direction} @ ${entry}`);
    } else {
        const alignment = getCurrentAlignment(symbol, direction);
        console.warn(`  [STATS] Orphan ${action}: ${symbol} ${tf} ${direction} @ ${entry}`);
        stats.trades.push({
            id:           makeTradeId(symbol, tf),
            direction,
            entry:        parseFloat(entry) || entry,
            sl: null, tp: null, rr: null,
            channel:      'UNKNOWN',
            alignment:    alignment,
            status:       action,
            signal_time:  null,
            entry_time:   null,
            result_time:  Date.now()
        });
    }
    await saveStats();
    broadcastStats();
}

// ══════════════════════════════════════════════
// ALIGNMENT
// ══════════════════════════════════════════════
function recalculateAlignment(symbol) {
    if (!marketState[symbol]) return { dominantState:"NONE", bullCount:0, bearCount:0, partialState:"NONE", partialCount:0 };
    const tfs = marketState[symbol].timeframes || {};
    let bullCount = 0, bearCount = 0;
    ZONE_TIMEFRAMES.forEach(tf => {
        if (tfs[tf] === "BULLISH") bullCount++;
        if (tfs[tf] === "BEARISH") bearCount++;
    });
    let dominantState = "NONE";
    if (bullCount >= ALIGNMENT_THRESHOLD) dominantState = "BULLISH";
    if (bearCount >= ALIGNMENT_THRESHOLD) dominantState = "BEARISH";

    let partialState = "NONE", partialCount = 0;
    if (dominantState === "NONE") {
        if      (bullCount >= 2) { partialState = "BULLISH"; partialCount = bullCount; }
        else if (bearCount >= 2) { partialState = "BEARISH"; partialCount = bearCount; }
    }
    marketState[symbol].alignCount   = Math.max(bullCount, bearCount);
    marketState[symbol].partialState = partialState;
    marketState[symbol].partialCount = partialCount;
    return { dominantState, bullCount, bearCount, partialState, partialCount };
}

// ══════════════════════════════════════════════
// VALIDATORS
// ══════════════════════════════════════════════
function validateGodMode(symbol, direction) {
    if (!marketState[symbol]) return { valid: false, reason: "Not tracked" };
    const god = marketState[symbol].lastAlertedState;
    if (god === "NONE")    return { valid: false, reason: "No God-Mode (need 3/3)" };
    if (direction !== god) return { valid: false, reason: `Mismatch: ${direction} vs ${god}` };
    return { valid: true, godState: god };
}
function validatePartial(symbol, direction) {
    if (!marketState[symbol]) return { valid: false, reason: "Not tracked" };
    const tfs = marketState[symbol].timeframes || {};
    let count = 0;
    ZONE_TIMEFRAMES.forEach(tf => { if (tfs[tf] === direction) count++; });
    if (count < 2) return { valid: false, reason: `Only ${count}/3 aligned` };
    return { valid: true, alignCount: count };
}

// ══════════════════════════════════════════════
// TF NORMALIZER
// ══════════════════════════════════════════════
function normalizeTf(tf) {
    if (!tf) return null;
    const map = {
        "1":"1M","1M":"1M","1MIN":"1M",
        "3":"3M","3M":"3M","3MIN":"3M",
        "5":"5M","5M":"5M","5MIN":"5M",
        "15":"15M","15M":"15M","15MIN":"15M",
        "30":"30M","30M":"30M","30MIN":"30M",
        "60":"1H","1H":"1H","1HR":"1H",
        "240":"4H","4H":"4H",
        "1D":"1D","D":"1D"
    };
    return map[tf.toString().toUpperCase().trim()] || tf.toString().toUpperCase().trim();
}

// ══════════════════════════════════════════════
// REDIS BOOT
// ══════════════════════════════════════════════
const redisClient = createClient({ url: process.env.REDIS_URL });
redisClient.on('error', err => console.error('Redis Error:', err));
await redisClient.connect();
console.log('✅ Redis connected');

const savedState = await redisClient.get(REDIS_STATE_KEY);
if (savedState) {
    marketState = JSON.parse(savedState);
    console.log(`💾 Restored ${Object.keys(marketState).length} symbols`);
    for (const sym in marketState) {
        if (!marketState[sym].timeframes) marketState[sym].timeframes = { "1H":"NONE","30M":"NONE","15M":"NONE" };
        ["1H","30M","15M"].forEach(tf => { if (!marketState[sym].timeframes[tf]) marketState[sym].timeframes[tf] = "NONE"; });
        const { dominantState } = recalculateAlignment(sym);
        marketState[sym].lastAlertedState = dominantState !== "NONE" ? dominantState : "NONE";
        if (dominantState !== "NONE" && !marketState[sym].lastGodModeStartTime)
            marketState[sym].lastGodModeStartTime = Date.now();
    }
    await redisClient.set(REDIS_STATE_KEY, JSON.stringify(marketState));
}

const savedLog = await redisClient.get(REDIS_LOG_KEY);
if (savedLog) { activityLog = JSON.parse(savedLog); console.log(`📋 ${activityLog.length} log entries`); }

const savedStats = await redisClient.get(REDIS_STATS_KEY);
if (savedStats) {
    tradeStats = JSON.parse(savedStats);
    for (const sym in tradeStats) {
        for (const tf in tradeStats[sym]) {
            const s = tradeStats[sym][tf];
            if (!s.trades) s.trades = [];
            s.trades.forEach(t => {
                if (!t.id) t.id = makeTradeId(sym, tf);
                if (!t.alignment) t.alignment = 'NONE';
            });
        }
    }
    console.log(`📊 Stats for ${Object.keys(tradeStats).length} symbols`);
}

// ══════════════════════════════════════════════
// API ROUTES
// ══════════════════════════════════════════════
app.get('/api/state', (req, res) => res.json({ marketState, activityLog }));

app.get('/api/stats', (req, res) => {
    res.json({ tradeStats: buildEnrichedStats() });
});

app.get('/api/stream', (req, res) => {
    res.setHeader('Content-Type',      'text/event-stream');
    res.setHeader('Cache-Control',     'no-cache');
    res.setHeader('Connection',        'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    const id = Date.now();
    clients.push({ id, res });
    const ka = setInterval(() => res.write(': keepalive\n\n'), 15000);
    req.on('close', () => { clearInterval(ka); clients = clients.filter(c => c.id !== id); });
});

app.get('/api/stats-stream', (req, res) => {
    res.setHeader('Content-Type',      'text/event-stream');
    res.setHeader('Cache-Control',     'no-cache');
    res.setHeader('Connection',        'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    const id = Date.now();
    statsClients.push({ id, res });
    const ka = setInterval(() => res.write(': keepalive\n\n'), 15000);
    req.on('close', () => { clearInterval(ka); statsClients = statsClients.filter(c => c.id !== id); });
});

app.post('/api/delete', async (req, res) => {
    const { symbol, action } = req.body;
    if (!symbol || action !== 'DELETE') return res.status(400).send("Invalid payload");
    const sym = symbol.toUpperCase().trim();
    if (!marketState[sym]) return res.status(404).send("Not found");
    delete marketState[sym];
    await redisClient.set(REDIS_STATE_KEY, JSON.stringify(marketState));
    await pushLogEvent(sym, 'NONE', '🗑️ Purged');
    broadcastAll();
    res.send("Purged");
});

app.post('/api/delete-stats', async (req, res) => {
    const { symbol } = req.body;
    if (!symbol) return res.status(400).send("Invalid");
    const sym = symbol.toUpperCase().trim();
    if (sym === "ALL") { tradeStats = {}; }
    else {
        if (!tradeStats[sym]) return res.status(404).send("Not found");
        delete tradeStats[sym];
    }
    await saveStats();
    broadcastStats();
    res.send("Cleared");
});

// ══════════════════════════════════════════════
// MAIN WEBHOOK
// ══════════════════════════════════════════════
app.post('/webhook', async (req, res) => {
    const payload = req.body;
    const isStoryline = payload.state !== undefined && payload.tf !== undefined && payload.type === undefined;
    const isEntry     = payload.type  !== undefined;

    // ════════════════════════════════════════
    // STORYLINE
    // ════════════════════════════════════════
    if (isStoryline) {
        const sym   = (payload.symbol || '').toUpperCase().trim();
        const tf    = normalizeTf(payload.tf);
        const state = (payload.state || '').toUpperCase().trim();

        if (!sym || !tf || !state) return res.status(400).send("Invalid Storyline Payload");
        if (!ZONE_TIMEFRAMES.includes(tf)) {
            console.log(`[STORYLINE] ${sym} | ${tf} ignored`);
            return res.status(200).send("OK");
        }

        console.log(`\n[STORYLINE] ${sym} | ${tf} → ${state}`);

        if (!marketState[sym]) {
            marketState[sym] = {
                timeframes: { "1H":"NONE","30M":"NONE","15M":"NONE" },
                breakouts: { "1H":null,"30M":null,"15M":null },
                stopLosses: { "1H":null,"30M":null,"15M":null },
                lastAlertedState: "NONE",
                lastGodModeStartTime: null,
                alignCount: 0,
                partialState: "NONE",
                partialCount: 0
            };
        }

        if (!marketState[sym].timeframes) marketState[sym].timeframes = { "1H":"NONE","30M":"NONE","15M":"NONE" };
        marketState[sym].timeframes[tf] = state;
        if (payload.bo !== undefined) marketState[sym].breakouts[tf]  = payload.bo;
        if (payload.sl !== undefined) marketState[sym].stopLosses[tf] = payload.sl;

        const prev = marketState[sym].lastAlertedState;
        const { dominantState, bullCount, bearCount, partialState, partialCount } = recalculateAlignment(sym);
        console.log(`[ALIGN] ${sym} → God:${dominantState} Bull:${bullCount}/3 Bear:${bearCount}/3 Partial:${partialState}(${partialCount})`);

        if (dominantState !== "NONE" && dominantState !== prev) {
            const now = Date.now();
            marketState[sym].lastAlertedState     = dominantState;
            marketState[sym].lastGodModeStartTime = now;
            const emoji = dominantState === "BULLISH" ? "🚀 🐂" : "🩸 🐻";
            let msg  = `<b>${emoji} GOD-MODE: ${sym}</b>\n\n`;
            msg += `<b>Alignment:</b> ${dominantState} (3/3)\n`;
            msg += `<b>1H:</b>  ${marketState[sym].timeframes["1H"]}\n`;
            msg += `<b>30M:</b> ${marketState[sym].timeframes["30M"]}\n`;
            msg += `<b>15M:</b> ${marketState[sym].timeframes["15M"]}\n`;
            msg += `\n✅ All 3 timeframes aligned!`;
            await sendTelegram(TELEGRAM_STORYLINE_CHAT_ID, msg);
            await pushLogEvent(sym, dominantState, `GOD-MODE ON: ${dominantState} (3/3)`, now);
            console.log(`[GOD ON] ${sym} → ${dominantState}`);
        }

        if (dominantState === "NONE" && prev !== "NONE") {
            marketState[sym].lastAlertedState = "NONE";
            let msg  = `<b>⚠️ ALIGNMENT LOST: ${sym}</b>\n\n`;
            msg += `Was: ${prev} (3/3)\n`;
            msg += `Now: ${partialState !== "NONE" ? partialState + ` (${partialCount}/3)` : "No alignment"}`;
            await sendTelegram(TELEGRAM_STORYLINE_CHAT_ID, msg);
            await pushLogEvent(sym, 'NONE', `Alignment Lost: was ${prev}`, Date.now());
            console.log(`[GOD OFF] ${sym} → NONE`);
        }

        await redisClient.set(REDIS_STATE_KEY, JSON.stringify(marketState));
        broadcastAll();
        return res.status(200).send("OK");
    }

    // ════════════════════════════════════════
    // ENTRY WEBHOOK
    // ════════════════════════════════════════
    if (isEntry) {
        const sym          = (payload.symbol    || '').toUpperCase().trim();
        const type         =  payload.type      || '';
        const direction    = (payload.direction || '').toUpperCase().trim();
        const entry        =  payload.entry;
        const sl           =  payload.sl;
        const tp           =  payload.tp;
        const rr           =  payload.rr;
        const touchedLevel =  payload.touched_level || payload.touchedLevel || '';
        const action       = (payload.action    || 'SIGNAL').toUpperCase().trim();
        const entryTf      =  normalizeTf(payload.tf);

        if (!sym || !type || !direction || entry === undefined) {
            return res.status(400).send("Invalid Entry Payload");
        }

        console.log(`\n[${action}] ${sym} | ${type} | ${direction} | TF:${entryTf} | Entry:${entry} | SL:${sl} | TP:${tp}`);

        // ── SIGNAL ──
        if (action === "SIGNAL") {
            const newTradeId = await recordSignal(sym, entryTf, direction, entry, sl, tp, rr, touchedLevel);

            let soundTriggered = false;
            const godCheck = validateGodMode(sym, direction);
            const tfsInfo  = {
                "1H":  marketState[sym]?.timeframes?.["1H"]  || "?",
                "30M": marketState[sym]?.timeframes?.["30M"] || "?",
                "15M": marketState[sym]?.timeframes?.["15M"] || "?"
            };

            if (godCheck.valid) {
                const chatId = getGodChannel(entryTf);
                if (chatId) {
                    const emoji = direction === "BULLISH" ? "🟢 🐂" : "🔴 🐻";
                    let msg  = `<b>${emoji} GOD-MODE ENTRY: ${sym}</b>\n\n`;
                    msg += `<b>Type:</b>  ${type}\n`;
                    msg += `<b>TF:</b>    ${entryTf}\n`;
                    msg += `<b>Entry:</b> <code>${entry}</code>\n`;
                    msg += `<b>SL:</b>    <code>${sl}</code>\n`;
                    if (tp) msg += `<b>TP:</b>    <code>${tp}</code>\n`;
                    if (rr) msg += `<b>R:R:</b>   ${rr}\n`;
                    if (touchedLevel) msg += `<b>Level:</b> ${touchedLevel}\n`;
                    msg += `\n✅ <b>GOD-MODE (3/3)</b>\n`;
                    msg += `1H:${tfsInfo["1H"]} | 30M:${tfsInfo["30M"]} | 15M:${tfsInfo["15M"]}`;
                    const sent = await sendTelegram(chatId, msg);
                    if (sent) {
                        soundTriggered = true;
                        const s = tradeStats[sym]?.[entryTf];
                        if (s) {
                            const t = s.trades.find(t => t.id === newTradeId);
                            if (t) { t.channel = `GOD_${entryTf}`; t.alignment = 'GOD'; await saveStats(); broadcastStats(); }
                        }
                        console.log(`  ✅ [GOD ${entryTf}] Alert sent → ${sym}`);
                    }
                }
            }

            if (!godCheck.valid) {
                const partialCheck = validatePartial(sym, direction);
                if (partialCheck.valid) {
                    const chatId = getPartialChannel(entryTf);
                    if (chatId) {
                        const emoji = direction === "BULLISH" ? "🟡 🐂" : "🟠 🐻";
                        let msg  = `<b>${emoji} PARTIAL ENTRY: ${sym}</b>\n\n`;
                        msg += `<b>Type:</b>  ${type}\n`;
                        msg += `<b>TF:</b>    ${entryTf}\n`;
                        msg += `<b>Entry:</b> <code>${entry}</code>\n`;
                        msg += `<b>SL:</b>    <code>${sl}</code>\n`;
                        if (tp) msg += `<b>TP:</b>    <code>${tp}</code>\n`;
                        if (rr) msg += `<b>R:R:</b>   ${rr}\n`;
                        if (touchedLevel) msg += `<b>Level:</b> ${touchedLevel}\n`;
                        msg += `\n⚡ <b>PARTIAL (${partialCheck.alignCount}/3)</b>\n`;
                        msg += `1H:${tfsInfo["1H"]} | 30M:${tfsInfo["30M"]} | 15M:${tfsInfo["15M"]}`;
                        const sent = await sendTelegram(chatId, msg);
                        if (sent) {
                            if (!soundTriggered) soundTriggered = true;
                            const s = tradeStats[sym]?.[entryTf];
                            if (s) {
                                const t = s.trades.find(t => t.id === newTradeId);
                                if (t) { t.channel = `PARTIAL_${entryTf}`; t.alignment = 'PARTIAL'; await saveStats(); broadcastStats(); }
                            }
                            console.log(`  ✅ [PARTIAL ${entryTf}] Alert sent → ${sym}`);
                        }
                    }
                } else {
                    console.log(`  ❌ No alignment: ${sym} | ${partialCheck.reason}`);
                }
            }

            if (soundTriggered) broadcastSoundAlert(sym, direction);
            await pushLogEvent(sym, direction,
                `${type} ${entryTf} SIGNAL | Entry:${entry} SL:${sl}${godCheck.valid ? ' ✅GOD' : ''}`,
                Date.now()
            );
            broadcastAll();
            return res.status(200).send("OK");
        }

        if (action === "ENTRY_FILLED") {
            await recordEntryFilled(sym, entryTf, direction, entry);
            await pushLogEvent(sym, direction, `📥 FILLED: ${type} ${entryTf} @ ${entry}`, Date.now());
            broadcastAll();
            return res.status(200).send("OK");
        }

        if (action === "TP_HIT") {
            await recordResult(sym, entryTf, direction, entry, 'TP_HIT');
            await pushLogEvent(sym, 'BULLISH', `🎯 TP HIT: ${type} ${entryTf} @ ${entry}`, Date.now());
            broadcastAll();
            return res.status(200).send("OK");
        }

        if (action === "SL_HIT") {
            await recordResult(sym, entryTf, direction, entry, 'SL_HIT');
            await pushLogEvent(sym, 'BEARISH', `💀 SL HIT: ${type} ${entryTf} @ ${entry}`, Date.now());
            broadcastAll();
            return res.status(200).send("OK");
        }

        console.warn(`[ENTRY] Unknown action: ${action}`);
        return res.status(400).send("Unknown action");
    }

    return res.status(400).send("Unknown payload format");
});

// ══════════════════════════════════════════════
// PAGE ROUTES
// ══════════════════════════════════════════════
app.get('/',      (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/stats', (req, res) => res.sendFile(path.join(__dirname, 'public', 'stats.html')));

// ══════════════════════════════════════════════
// START
// ══════════════════════════════════════════════
app.listen(PORT, () => {
    console.log(`\n🚀 God-Mode V3 on port ${PORT}`);
    console.log(`📊 Alignment: ${ALIGNMENT_THRESHOLD}/3 (1H+30M+15M)`);
    console.log(`📡 God  [5M/3M/1M]: ${TG_5M_GOD} / ${TG_3M_GOD} / ${TG_1M_GOD}`);
    console.log(`📡 Part [5M/3M/1M]: ${TG_5M_PARTIAL} / ${TG_3M_PARTIAL} / ${TG_1M_PARTIAL}`);
});
