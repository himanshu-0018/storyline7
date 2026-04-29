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

const TG_1M_ENTRIES = process.env.TG_1M_ENTRIES;
const TG_3M_ENTRIES = process.env.TG_3M_ENTRIES;
const TG_5M_ENTRIES = process.env.TG_5M_ENTRIES;

const REDIS_STATE_KEY     = process.env.REDIS_KEY || 'godModeState_v4';
const REDIS_LOG_KEY       = REDIS_STATE_KEY + '_activityLog';
const REDIS_STATS_KEY     = REDIS_STATE_KEY + '_tradeStats';

const ZONE_TIMEFRAMES     = ["1W", "1D", "4H", "1H", "30M", "15M"];
const GOD_THRESHOLD       = 6;
const PARTIAL_THRESHOLD   = 5;

const ENTRY_TFS = ["1M", "3M", "5M"];

const TG_CHANNEL_MAP = {
    "1M": () => TG_1M_ENTRIES,
    "3M": () => TG_3M_ENTRIES,
    "5M": () => TG_5M_ENTRIES
};

// ═══ ALIGNMENT COMBOS FOR STATS ═══
const ALIGNMENT_COMBOS = [
    { id: "W_D_4H",             label: "W+D+4H",              tfs: ["1W","1D","4H"] },
    { id: "W_D_4H_1H",          label: "W+D+4H+1H",           tfs: ["1W","1D","4H","1H"] },
    { id: "W_D_4H_1H_30M",      label: "W+D+4H+1H+30M",       tfs: ["1W","1D","4H","1H","30M"] },
    { id: "W_D_4H_1H_30M_15M",  label: "W+D+4H+1H+30M+15M",   tfs: ["1W","1D","4H","1H","30M","15M"] },
    { id: "D_4H",               label: "D+4H",                tfs: ["1D","4H"] },
    { id: "D_4H_1H",            label: "D+4H+1H",             tfs: ["1D","4H","1H"] },
    { id: "D_4H_1H_30M",        label: "D+4H+1H+30M",         tfs: ["1D","4H","1H","30M"] },
    { id: "D_4H_1H_30M_15M",    label: "D+4H+1H+30M+15M",     tfs: ["1D","4H","1H","30M","15M"] },
    { id: "4H_1H",              label: "4H+1H",               tfs: ["4H","1H"] },
    { id: "4H_1H_30M",          label: "4H+1H+30M",           tfs: ["4H","1H","30M"] },
    { id: "4H_1H_30M_15M",      label: "4H+1H+30M+15M",       tfs: ["4H","1H","30M","15M"] }
];

let marketState  = {};
let activityLog  = [];
let tradeStats   = {};
let clients      = [];
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
    const data = JSON.stringify({ tradeStats: buildEnrichedStats() });
    statsClients.forEach(c => c.res.write(`data: ${data}\n\n`));
}

// ══════════════════════════════════════════════
// TELEGRAM
// ══════════════════════════════════════════════
async function sendTelegramTracked(chatId, message) {
    if (!TELEGRAM_TOKEN || !chatId) return { ok: false, messageId: null };
    try {
        const resp = await fetch(
            `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: "HTML" })
            }
        );
        if (!resp.ok) return { ok: false, messageId: null };
        const data = await resp.json();
        return { ok: true, messageId: data?.result?.message_id || null };
    } catch (err) {
        console.error("Telegram Send Error:", err);
        return { ok: false, messageId: null };
    }
}

async function deleteTelegramMessage(chatId, messageId) {
    if (!TELEGRAM_TOKEN || !chatId || !messageId) return false;
    try {
        const resp = await fetch(
            `https://api.telegram.org/bot${TELEGRAM_TOKEN}/deleteMessage`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: chatId, message_id: messageId })
            }
        );
        return resp.ok;
    } catch (err) {
        console.error("Telegram Delete Error:", err);
        return false;
    }
}

async function sendTelegram(chatId, message) {
    if (!TELEGRAM_TOKEN || !chatId) return false;
    try {
        const resp = await fetch(
            `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: "HTML" })
            }
        );
        return resp.ok;
    } catch (err) {
        console.error("Telegram Error:", err);
        return false;
    }
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
// PRICE MATCH — 0.05% tolerance
// ══════════════════════════════════════════════
function priceMatch(a, b) {
    const fa = parseFloat(a);
    const fb = parseFloat(b);
    if (isNaN(fa) || isNaN(fb)) return false;
    const tol = Math.max(Math.abs(fa), Math.abs(fb)) * 0.0005;
    return Math.abs(fa - fb) <= tol;
}

function makeTradeId(symbol, tf) {
    return `${symbol}_${tf}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

// ══════════════════════════════════════════════
// ALIGNMENT COMBO CALCULATOR
// ══════════════════════════════════════════════
function getMatchedCombos(symbol, direction) {
    if (!marketState[symbol]) return [];
    const tfs = marketState[symbol].timeframes || {};
    const matched = [];
    for (const combo of ALIGNMENT_COMBOS) {
        const allMatch = combo.tfs.every(tf => tfs[tf] === direction);
        if (allMatch) {
            matched.push(combo.id);
        }
    }
    return matched;
}

function getAlignmentSummary(symbol, direction) {
    if (!marketState[symbol]) return { count: 0, combos: [], godMode: false, partial: false };
    const tfs = marketState[symbol].timeframes || {};
    let count = 0;
    ZONE_TIMEFRAMES.forEach(tf => {
        if (tfs[tf] === direction) count++;
    });
    const combos = getMatchedCombos(symbol, direction);
    return {
        count,
        combos,
        godMode: count >= GOD_THRESHOLD,
        partial: count >= PARTIAL_THRESHOLD && count < GOD_THRESHOLD
    };
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
    let pending=0, active=0, tp=0, sl=0, entries=0;
    let god_tp=0, god_sl=0, god_signals=0;
    let partial_tp=0, partial_sl=0, partial_signals=0;

    for (const t of stats.trades) {
        if (t.status === 'CANCELLED') continue;
        const align = t.alignment || 'NONE';
        if (t.status === 'SIGNAL')  pending++;
        if (t.status === 'ACTIVE')  { active++;  entries++; }
        if (t.status === 'TP_HIT')  { tp++;      entries++; }
        if (t.status === 'SL_HIT')  { sl++;      entries++; }

        if (align === 'GOD') {
            god_signals++;
            if (t.status === 'TP_HIT') god_tp++;
            if (t.status === 'SL_HIT') god_sl++;
        } else if (align === 'PARTIAL') {
            partial_signals++;
            if (t.status === 'TP_HIT') partial_tp++;
            if (t.status === 'SL_HIT') partial_sl++;
        }
    }
    return {
        pending, active, tp_hits: tp, sl_hits: sl, total_entries: entries,
        god_tp, god_sl, god_signals,
        partial_tp, partial_sl, partial_signals
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
                total_signals:    s.total_signals || 0,
                total_entries:    counts.total_entries,
                tp_hits:          counts.tp_hits,
                sl_hits:          counts.sl_hits,
                pending:          counts.pending,
                active:           counts.active,
                god_tp:           counts.god_tp,
                god_sl:           counts.god_sl,
                god_signals:      counts.god_signals,
                partial_tp:       counts.partial_tp,
                partial_sl:       counts.partial_sl,
                partial_signals:  counts.partial_signals,
                trades:           s.trades
            };
        }
    }
    return enriched;
}

async function saveStats() {
    await redisClient.set(REDIS_STATS_KEY, JSON.stringify(tradeStats));
}

// ══════════════════════════════════════════════
// TRADE FINDER (FIFO)
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
            if (t.direction === direction && allowedStatuses.includes(t.status) && priceMatch(t.entry, entry))
                candidates.push({ trade: t, index: i });
        }
    }

    if (candidates.length === 0 && entry !== undefined && entry !== null) {
        for (let i = 0; i < trades.length; i++) {
            const t = trades[i];
            if (t.direction === direction && priceMatch(t.entry, entry) && ['SIGNAL','ACTIVE'].includes(t.status))
                candidates.push({ trade: t, index: i });
        }
    }

    if (candidates.length === 0) {
        for (let i = 0; i < trades.length; i++) {
            const t = trades[i];
            if (t.direction === direction && allowedStatuses.includes(t.status))
                candidates.push({ trade: t, index: i });
        }
    }

    if (candidates.length === 0) return null;
    candidates.sort((a, b) => a.index - b.index);
    return candidates[0];
}

// ══════════════════════════════════════════════
// ALIGNMENT ENGINE
// ══════════════════════════════════════════════
function recalculateAlignment(symbol) {
    if (!marketState[symbol]) return { dominantState:"NONE", bullCount:0, bearCount:0, alignCount:0, partialState:"NONE", partialCount:0 };
    const tfs = marketState[symbol].timeframes || {};
    let bullCount = 0, bearCount = 0;
    ZONE_TIMEFRAMES.forEach(tf => {
        if (tfs[tf] === "BULLISH") bullCount++;
        if (tfs[tf] === "BEARISH") bearCount++;
    });

    let dominantState = "NONE";
    if (bullCount >= GOD_THRESHOLD) dominantState = "BULLISH";
    if (bearCount >= GOD_THRESHOLD) dominantState = "BEARISH";

    let partialState = "NONE", partialCount = 0;
    if (dominantState === "NONE") {
        if      (bullCount >= PARTIAL_THRESHOLD) { partialState = "BULLISH"; partialCount = bullCount; }
        else if (bearCount >= PARTIAL_THRESHOLD) { partialState = "BEARISH"; partialCount = bearCount; }
    }

    marketState[symbol].alignCount   = Math.max(bullCount, bearCount);
    marketState[symbol].partialState = partialState;
    marketState[symbol].partialCount = partialCount;
    return { dominantState, bullCount, bearCount, alignCount: Math.max(bullCount, bearCount), partialState, partialCount };
}

function getDirectionAlignCount(symbol, direction) {
    if (!marketState[symbol]) return 0;
    const tfs = marketState[symbol].timeframes || {};
    let count = 0;
    ZONE_TIMEFRAMES.forEach(tf => {
        if (tfs[tf] === direction) count++;
    });
    return count;
}

function validateGodMode(symbol, direction) {
    if (!marketState[symbol]) return { valid: false, reason: "Not tracked" };
    const god = marketState[symbol].lastAlertedState;
    if (god === "NONE")    return { valid: false, reason: "No God-Mode (need 6/6)" };
    if (direction !== god) return { valid: false, reason: `Direction mismatch: signal=${direction}, god=${god}` };
    return { valid: true, godState: god };
}

function validatePartial(symbol, direction) {
    if (!marketState[symbol]) return { valid: false, reason: "Not tracked" };
    if (marketState[symbol].lastAlertedState === direction) return { valid: false, reason: "Already God-Mode" };
    const tfs = marketState[symbol].timeframes || {};
    let count = 0;
    ZONE_TIMEFRAMES.forEach(tf => { if (tfs[tf] === direction) count++; });
    if (count < PARTIAL_THRESHOLD) return { valid: false, reason: `Only ${count}/6 aligned for ${direction}` };
    return { valid: true, alignCount: count };
}

function getAlignmentType(symbol, direction) {
    const godCheck = validateGodMode(symbol, direction);
    if (godCheck.valid) return { type: 'GOD', valid: true, alignCount: 6 };
    const partialCheck = validatePartial(symbol, direction);
    if (partialCheck.valid) return { type: 'PARTIAL', valid: true, alignCount: partialCheck.alignCount };
    return { type: 'NONE', valid: false, reason: partialCheck.reason };
}

// ══════════════════════════════════════════════
// CANCEL PENDING TRADES ON ALIGNMENT DROP
// ══════════════════════════════════════════════
async function invalidatePendingTrades(symbol) {
    let totalCancelled = 0;

    for (const tf of ENTRY_TFS) {
        const stats = tradeStats[symbol]?.[tf];
        if (!stats || !stats.trades || stats.trades.length === 0) continue;

        for (const trade of stats.trades) {
            if (trade.status !== 'SIGNAL') continue;

            const count = getDirectionAlignCount(symbol, trade.direction);
            if (count < PARTIAL_THRESHOLD) {
                trade.status = 'CANCELLED';
                trade.cancelled_time = Date.now();
                trade.cancelled_reason = `Alignment dropped to ${count}/6`;

                if (stats.total_signals > 0) stats.total_signals--;

                let deleted = false;
                if (trade.telegram_chat_id && trade.telegram_message_id) {
                    deleted = await deleteTelegramMessage(trade.telegram_chat_id, trade.telegram_message_id);
                    trade.telegram_deleted = deleted;
                }

                await pushLogEvent(
                    symbol, 'NONE',
                    `❌ CANCELLED: ${trade.direction} ${tf} @ ${trade.entry} (${trade.cancelled_reason})${trade.telegram_message_id ? (deleted ? ' | TG deleted ✅' : ' | TG delete failed ❌') : ''}`,
                    Date.now()
                );

                console.log(`[CANCELLED] ${symbol} ${tf} ${trade.direction} @ ${trade.entry} | ${trade.cancelled_reason} | TG deleted: ${deleted}`);
                totalCancelled++;
            }
        }
    }

    if (totalCancelled > 0) {
        await saveStats();
        broadcastStats();
    }
    return totalCancelled;
}

// ══════════════════════════════════════════════
// RECORD FUNCTIONS
// ══════════════════════════════════════════════
async function recordSignal(symbol, tf, direction, entry, sl, tp, rr, alignmentType, alignCombos, alignCount) {
    const stats = ensureStats(symbol, tf);
    stats.total_signals++;

    const trade = {
        id:              makeTradeId(symbol, tf),
        trade_type:      'OB',
        direction,
        entry:           parseFloat(entry) || entry,
        sl:              parseFloat(sl)    || sl,
        tp:              parseFloat(tp)    || tp,
        rr:              parseFloat(rr)    || rr,
        channel:         `${tf}_ENTRIES`,
        alignment:       alignmentType,
        align_combos:    alignCombos || [],
        align_count:     alignCount || 0,
        status:          'SIGNAL',
        signal_time:     Date.now(),
        entry_time:      null,
        result_time:     null,
        entry_tf:        tf,
        telegram_chat_id:    null,
        telegram_message_id: null,
        telegram_deleted:    false,
        cancelled_time:   null,
        cancelled_reason: null
    };
    stats.trades.push(trade);
    if (stats.trades.length > 500) stats.trades = stats.trades.slice(-500);

    console.log(`  [STATS] Signal recorded: ${symbol} ${tf} ${direction} @ ${entry} | Alignment: ${alignmentType} | Combos: ${alignCombos.join(',')}`);
    await saveStats();
    broadcastStats();
    return trade.id;
}

async function recordEntryFilled(symbol, tf, direction, entry) {
    const stats = tradeStats[symbol]?.[tf];
    if (!stats) {
        console.log(`  [STATS] ENTRY_FILLED skipped — no stats for ${symbol} ${tf}`);
        return false;
    }
    const found = findBestTrade(stats, { direction, entry, allowedStatuses: ['SIGNAL'] });
    if (found) {
        found.trade.status     = 'ACTIVE';
        found.trade.entry_time = Date.now();
        console.log(`  [STATS] Entry filled: ID=${found.trade.id} | ${symbol} ${tf} ${direction} @ ${entry}`);
        await saveStats();
        broadcastStats();
        return true;
    } else {
        console.log(`  [STATS] ENTRY_FILLED — no matching SIGNAL found for ${symbol} ${tf} ${direction} @ ${entry}`);
        return false;
    }
}

async function recordResult(symbol, tf, direction, entry, action) {
    const stats = tradeStats[symbol]?.[tf];
    if (!stats) {
        console.log(`  [STATS] ${action} skipped — no stats for ${symbol} ${tf}`);
        return false;
    }
    const found = findBestTrade(stats, { direction, entry, allowedStatuses: ['ACTIVE', 'SIGNAL'] });
    if (found) {
        const wasSameCandle = found.trade.status === 'SIGNAL';
        found.trade.status      = action;
        found.trade.result_time = Date.now();
        if (wasSameCandle) found.trade.entry_time = Date.now();
        console.log(`  [STATS] ${action}: ID=${found.trade.id} | ${symbol} ${tf} ${direction} @ ${entry}`);
        await saveStats();
        broadcastStats();
        return true;
    } else {
        console.log(`  [STATS] ${action} — no matching trade for ${symbol} ${tf} ${direction} @ ${entry}`);
        return false;
    }
}

async function recordEntryAndResult(symbol, tf, direction, entry, resultAction) {
    const stats = tradeStats[symbol]?.[tf];
    if (!stats) {
        console.log(`  [STATS] ${resultAction} (combo) skipped — no stats for ${symbol} ${tf}`);
        return false;
    }
    const found = findBestTrade(stats, { direction, entry, allowedStatuses: ['SIGNAL', 'ACTIVE'] });
    if (found) {
        found.trade.status      = resultAction;
        found.trade.entry_time  = Date.now();
        found.trade.result_time = Date.now();
        console.log(`  [STATS] ENTRY+${resultAction}: ID=${found.trade.id} | ${symbol} ${tf} ${direction} @ ${entry}`);
        await saveStats();
        broadcastStats();
        return true;
    } else {
        console.log(`  [STATS] ENTRY+${resultAction} — no matching trade for ${symbol} ${tf} ${direction} @ ${entry}`);
        return false;
    }
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
        "1D":"1D","D":"1D",
        "1W":"1W","W":"1W","WEEKLY":"1W"
    };
    return map[tf.toString().toUpperCase().trim()] || tf.toString().toUpperCase().trim();
}

function tfInfoString(sym) {
    const tfs = marketState[sym]?.timeframes || {};
    return ZONE_TIMEFRAMES.map(tf => `${tf}: ${tfs[tf] || '?'}`).join('\n');
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
        if (!marketState[sym].timeframes) marketState[sym].timeframes = {};
        ZONE_TIMEFRAMES.forEach(tf => {
            if (!marketState[sym].timeframes[tf]) marketState[sym].timeframes[tf] = "NONE";
        });
        const { dominantState } = recalculateAlignment(sym);
        marketState[sym].lastAlertedState = dominantState !== "NONE" ? dominantState : "NONE";
        if (dominantState !== "NONE" && !marketState[sym].lastGodModeStartTime)
            marketState[sym].lastGodModeStartTime = Date.now();
    }
    await redisClient.set(REDIS_STATE_KEY, JSON.stringify(marketState));
} else {
    console.log('🆕 No saved state found');
}

const savedLog = await redisClient.get(REDIS_LOG_KEY);
if (savedLog) {
    activityLog = JSON.parse(savedLog);
    console.log(`📋 ${activityLog.length} log entries`);
}

const savedStats = await redisClient.get(REDIS_STATS_KEY);
if (savedStats) {
    tradeStats = JSON.parse(savedStats);
    for (const sym in tradeStats) {
        for (const tf in tradeStats[sym]) {
            const s = tradeStats[sym][tf];
            if (!s.trades) s.trades = [];
            s.trades.forEach(t => {
                if (!t.id)            t.id            = makeTradeId(sym, tf);
                if (!t.alignment)     t.alignment     = 'NONE';
                if (!t.entry_tf)      t.entry_tf      = tf;
                if (!t.align_combos)  t.align_combos  = [];
                if (!t.align_count)   t.align_count   = 0;
            });
        }
    }
    console.log(`📊 Stats for ${Object.keys(tradeStats).length} symbols`);
}

// ══════════════════════════════════════════════
// API ROUTES
// ══════════════════════════════════════════════
app.get('/api/state', (req, res) => res.json({ marketState, activityLog }));
app.get('/api/stats', (req, res) => res.json({ tradeStats: buildEnrichedStats(), alignmentCombos: ALIGNMENT_COMBOS }));

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
    if (!symbol || action !== 'DELETE') return res.status(400).send("Invalid");
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

    // ═══ DETECT PAYLOAD TYPE ═══
    // Storyline: has state + tf, no type, no coin, no action
    const isStoryline = payload.state !== undefined && payload.tf !== undefined && payload.coin === undefined && payload.action === undefined;
    // PineScript OB entry: has coin + action
    const isPineEntry = payload.coin !== undefined && payload.action !== undefined;
    // Legacy entry format: has type + direction (but no coin)
    const isLegacyEntry = payload.type !== undefined && payload.coin === undefined;

    // ════════════════════════════════════════
    // STORYLINE — 1W / 1D / 4H / 1H / 30M / 15M
    // ════════════════════════════════════════
    if (isStoryline) {
        const sym   = (payload.symbol || '').toUpperCase().trim();
        const tf    = normalizeTf(payload.tf);
        const state = (payload.state || '').toUpperCase().trim();

        if (!sym || !tf || !state) return res.status(400).send("Invalid Storyline Payload");
        if (!ZONE_TIMEFRAMES.includes(tf)) {
            console.log(`[STORYLINE] ${sym} | ${tf} ignored — not tracked`);
            return res.status(200).send("OK");
        }

        console.log(`\n[STORYLINE] ${sym} | ${tf} → ${state}`);

        if (!marketState[sym]) {
            const defaultTfs = {};
            ZONE_TIMEFRAMES.forEach(t => defaultTfs[t] = "NONE");
            marketState[sym] = {
                timeframes:           defaultTfs,
                lastAlertedState:     "NONE",
                lastGodModeStartTime: null,
                alignCount:           0,
                partialState:         "NONE",
                partialCount:         0
            };
        }
        if (!marketState[sym].timeframes) {
            marketState[sym].timeframes = {};
            ZONE_TIMEFRAMES.forEach(t => marketState[sym].timeframes[t] = "NONE");
        }

        marketState[sym].timeframes[tf] = state;

        const prev = marketState[sym].lastAlertedState;
        const { dominantState, bullCount, bearCount, alignCount, partialState, partialCount } = recalculateAlignment(sym);
        console.log(`[ALIGN] ${sym} → God:${dominantState} | Bull:${bullCount}/6 Bear:${bearCount}/6 | Partial:${partialState}(${partialCount}/6)`);

        if (dominantState !== "NONE" && dominantState !== prev) {
            const now = Date.now();
            marketState[sym].lastAlertedState     = dominantState;
            marketState[sym].lastGodModeStartTime = now;
            const emoji = dominantState === "BULLISH" ? "🚀 🐂" : "🩸 🐻";
            let msg  = `<b>${emoji} GOD-MODE: ${sym}</b>\n\n`;
            msg += `<b>Alignment:</b> ${dominantState} (6/6)\n`;
            msg += `${tfInfoString(sym)}\n`;
            msg += `\n✅ All 6 timeframes aligned!`;
            await sendTelegram(TELEGRAM_STORYLINE_CHAT_ID, msg);
            await pushLogEvent(sym, dominantState, `GOD-MODE ON: ${dominantState} (6/6)`, now);
            console.log(`[GOD ON] ${sym} → ${dominantState}`);
        }

        if (dominantState === "NONE" && prev !== "NONE") {
            marketState[sym].lastAlertedState = "NONE";
            let msg  = `<b>⚠️ ALIGNMENT LOST: ${sym}</b>\n\n`;
            msg += `Was: ${prev} (6/6)\n`;
            msg += `Now: ${partialState !== "NONE" ? partialState + ` (${partialCount}/6)` : `${alignCount}/6`}\n`;
            msg += `${tfInfoString(sym)}`;
            await sendTelegram(TELEGRAM_STORYLINE_CHAT_ID, msg);
            await pushLogEvent(sym, 'NONE', `Alignment Lost: was ${prev} (6/6)`, Date.now());
            console.log(`[GOD OFF] ${sym} → NONE`);
        }

        if (dominantState === "NONE" && partialState !== "NONE") {
            const prevPartial = marketState[sym]._lastPartialState || "NONE";
            if (prevPartial !== partialState || (prev !== "NONE" && dominantState === "NONE")) {
                const emoji = partialState === "BULLISH" ? "⚡ 🐂" : "⚡ 🐻";
                let msg  = `<b>${emoji} PARTIAL: ${sym}</b>\n\n`;
                msg += `<b>Alignment:</b> ${partialState} (${partialCount}/6)\n`;
                msg += `${tfInfoString(sym)}`;
                await sendTelegram(TELEGRAM_STORYLINE_CHAT_ID, msg);
                await pushLogEvent(sym, partialState, `PARTIAL: ${partialState} (${partialCount}/6)`, Date.now());
            }
        }
        marketState[sym]._lastPartialState = partialState;

        const cancelledCount = await invalidatePendingTrades(sym);
        if (cancelledCount > 0) {
            console.log(`[INVALIDATION] ${sym} → Cancelled ${cancelledCount} pending trade(s)`);
        }

        await redisClient.set(REDIS_STATE_KEY, JSON.stringify(marketState));
        broadcastAll();
        return res.status(200).send("OK");
    }

    // ════════════════════════════════════════
    // PINESCRIPT OB ENTRY — coin + chart_tf + action
    // ════════════════════════════════════════
    if (isPineEntry) {
        const sym       = (payload.coin || '').toUpperCase().trim();
        const direction = (payload.direction || '').toUpperCase().trim();
        const entry     =  payload.entry;
        const sl        =  payload.sl;
        const tp        =  payload.tp;
        const rr        =  payload.rr;
        const action    = (payload.action || '').toUpperCase().trim();
        const entryTf   =  normalizeTf(payload.chart_tf);

        if (!sym || !direction || entry === undefined) {
            return res.status(400).send("Invalid PineScript Entry Payload");
        }

        if (!ENTRY_TFS.includes(entryTf)) {
            console.log(`[PINE ${action}] ${sym} | TF:${entryTf} — IGNORED (only ${ENTRY_TFS.join('/')} accepted)`);
            return res.status(200).send(`OK — Only ${ENTRY_TFS.join('/')} entries accepted`);
        }

        console.log(`\n[PINE ${action}] ${sym} | ${direction} | TF:${entryTf} | Entry:${entry} | SL:${sl} | TP:${tp}`);

        // ══════════════════════════════════════
        // OB_FORMED — New signal
        // ══════════════════════════════════════
        if (action === "OB_FORMED") {

            // Check alignment + direction match
            const alignResult = getAlignmentType(sym, direction);

            if (!alignResult.valid) {
                console.log(`  ❌ REJECTED: ${sym} ${direction} ${entryTf} | Reason: ${alignResult.reason}`);
                return res.status(200).send("OK — No alignment, skipped");
            }

            // Get alignment combos at signal time
            const alignSummary = getAlignmentSummary(sym, direction);

            console.log(`  ✅ ALIGNED [${alignResult.type}] ${sym} ${direction} ${entryTf} (${alignSummary.count}/6) | Combos: ${alignSummary.combos.join(',')}`);

            // Record to stats with combos
            const newTradeId = await recordSignal(
                sym, entryTf, direction, entry, sl, tp, rr,
                alignResult.type, alignSummary.combos, alignSummary.count
            );

            // Send to TF-specific Telegram channel
            const tfsInfo = tfInfoString(sym);
            let soundTriggered = false;
            const chatId = TG_CHANNEL_MAP[entryTf]?.();

            if (chatId) {
                const alignLabel = alignResult.type === 'GOD' ? 'GOD-MODE (6/6)' : `PARTIAL (${alignSummary.count}/6)`;
                const alignEmoji = alignResult.type === 'GOD' ? '✅' : '⚡';
                const dirEmoji   = direction === "BULLISH" ? "🟢 🐂" : "🔴 🐻";

                let msg  = `<b>${dirEmoji} ${entryTf} OB SIGNAL: ${sym}</b>\n\n`;
                msg += `<b>TF:</b>    ${entryTf}\n`;
                msg += `<b>Entry:</b> <code>${entry}</code>\n`;
                msg += `<b>SL:</b>    <code>${sl}</code>\n`;
                if (tp) msg += `<b>TP:</b>    <code>${tp}</code>\n`;
                if (rr) msg += `<b>R:R:</b>   ${rr}\n`;
                msg += `\n${alignEmoji} <b>${alignLabel}</b>\n`;
                msg += `<b>Combos:</b> ${alignSummary.combos.length > 0 ? alignSummary.combos.join(', ') : 'None'}\n`;
                msg += `${tfsInfo}`;

                const sent = await sendTelegramTracked(chatId, msg);
                if (sent.ok) {
                    soundTriggered = true;
                    const s = tradeStats[sym]?.[entryTf];
                    if (s) {
                        const t = s.trades.find(t => t.id === newTradeId);
                        if (t) {
                            t.telegram_chat_id    = chatId;
                            t.telegram_message_id = sent.messageId;
                            await saveStats();
                            broadcastStats();
                        }
                    }
                    console.log(`  ✅ [${entryTf} ENTRIES] Telegram sent → ${sym} | msg_id=${sent.messageId}`);
                }
            } else {
                console.log(`  ⚠️ No Telegram channel configured for ${entryTf}`);
            }

            if (soundTriggered) broadcastSoundAlert(sym, direction);

            await pushLogEvent(
                sym, direction,
                `OB ${entryTf} [${alignResult.type} ${alignSummary.count}/6] Entry:${entry} SL:${sl}`,
                Date.now()
            );
            broadcastAll();
            return res.status(200).send("OK");
        }

        // ══════════════════════════════════════
        // ENTRY_DONE — Entry filled
        // ══════════════════════════════════════
        if (action === "ENTRY_DONE") {
            const updated = await recordEntryFilled(sym, entryTf, direction, entry);
            if (updated) {
                await pushLogEvent(sym, direction, `📥 ENTRY FILLED: OB ${entryTf} @ ${entry}`, Date.now());
                broadcastAll();
            }
            return res.status(200).send("OK");
        }

        // ══════════════════════════════════════
        // ENTRY_AND_SL_HIT — Entry + immediate SL (counts as SL)
        // ══════════════════════════════════════
        if (action === "ENTRY_AND_SL_HIT") {
            const updated = await recordEntryAndResult(sym, entryTf, direction, entry, 'SL_HIT');
            if (updated) {
                await pushLogEvent(sym, 'BEARISH', `💀 ENTRY+SL HIT: OB ${entryTf} @ ${entry}`, Date.now());
                broadcastAll();
            }
            return res.status(200).send("OK");
        }

        // ══════════════════════════════════════
        // ENTRY_AND_TP_HIT — Entry + immediate TP (counts as TP)
        // ══════════════════════════════════════
        if (action === "ENTRY_AND_TP_HIT") {
            const updated = await recordEntryAndResult(sym, entryTf, direction, entry, 'TP_HIT');
            if (updated) {
                await pushLogEvent(sym, 'BULLISH', `🎯 ENTRY+TP HIT: OB ${entryTf} @ ${entry}`, Date.now());
                broadcastAll();
            }
            return res.status(200).send("OK");
        }

        // ══════════════════════════════════════
        // TP_HIT
        // ══════════════════════════════════════
        if (action === "TP_HIT") {
            const updated = await recordResult(sym, entryTf, direction, entry, 'TP_HIT');
            if (updated) {
                await pushLogEvent(sym, 'BULLISH', `🎯 TP HIT: OB ${entryTf} @ ${entry}`, Date.now());
                broadcastAll();
            }
            return res.status(200).send("OK");
        }

        // ══════════════════════════════════════
        // SL_HIT
        // ══════════════════════════════════════
        if (action === "SL_HIT") {
            const updated = await recordResult(sym, entryTf, direction, entry, 'SL_HIT');
            if (updated) {
                await pushLogEvent(sym, 'BEARISH', `💀 SL HIT: OB ${entryTf} @ ${entry}`, Date.now());
                broadcastAll();
            }
            return res.status(200).send("OK");
        }

        console.warn(`[PINE] Unknown action: ${action}`);
        return res.status(400).send("Unknown action");
    }

    // ════════════════════════════════════════
    // LEGACY ENTRY FORMAT (type-based)
    // ════════════════════════════════════════
    if (isLegacyEntry) {
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

        if (!ENTRY_TFS.includes(entryTf)) {
            console.log(`[${action}] ${sym} | TF:${entryTf} — IGNORED (only ${ENTRY_TFS.join('/')} accepted)`);
            return res.status(200).send(`OK — Only ${ENTRY_TFS.join('/')} entries accepted`);
        }

        console.log(`\n[LEGACY ${action}] ${sym} | ${type} | ${direction} | TF:${entryTf} | Entry:${entry}`);

        if (action === "SIGNAL") {
            const alignResult = getAlignmentType(sym, direction);
            if (!alignResult.valid) {
                console.log(`  ❌ REJECTED: ${sym} ${direction} ${entryTf} | Reason: ${alignResult.reason}`);
                return res.status(200).send("OK — No alignment, skipped");
            }

            const alignSummary = getAlignmentSummary(sym, direction);

            const newTradeId = await recordSignal(
                sym, entryTf, direction, entry, sl, tp, rr,
                alignResult.type, alignSummary.combos, alignSummary.count
            );

            const tfsInfo = tfInfoString(sym);
            let soundTriggered = false;
            const chatId = TG_CHANNEL_MAP[entryTf]?.();

            if (chatId) {
                const alignLabel = alignResult.type === 'GOD' ? 'GOD-MODE (6/6)' : `PARTIAL (${alignSummary.count}/6)`;
                const alignEmoji = alignResult.type === 'GOD' ? '✅' : '⚡';
                const dirEmoji   = direction === "BULLISH" ? "🟢 🐂" : "🔴 🐻";

                let msg  = `<b>${dirEmoji} ${entryTf} ENTRY: ${sym}</b>\n\n`;
                msg += `<b>Type:</b>  ${type}\n`;
                msg += `<b>TF:</b>    ${entryTf}\n`;
                msg += `<b>Entry:</b> <code>${entry}</code>\n`;
                msg += `<b>SL:</b>    <code>${sl}</code>\n`;
                if (tp) msg += `<b>TP:</b>    <code>${tp}</code>\n`;
                if (rr) msg += `<b>R:R:</b>   ${rr}\n`;
                if (touchedLevel) msg += `<b>Level:</b> ${touchedLevel}\n`;
                msg += `\n${alignEmoji} <b>${alignLabel}</b>\n${tfsInfo}`;

                const sent = await sendTelegramTracked(chatId, msg);
                if (sent.ok) {
                    soundTriggered = true;
                    const s = tradeStats[sym]?.[entryTf];
                    if (s) {
                        const t = s.trades.find(t => t.id === newTradeId);
                        if (t) {
                            t.telegram_chat_id    = chatId;
                            t.telegram_message_id = sent.messageId;
                            await saveStats();
                            broadcastStats();
                        }
                    }
                }
            }

            if (soundTriggered) broadcastSoundAlert(sym, direction);

            await pushLogEvent(
                sym, direction,
                `${type} ${entryTf} [${alignResult.type} ${alignSummary.count}/6] Entry:${entry} SL:${sl}`,
                Date.now()
            );
            broadcastAll();
            return res.status(200).send("OK");
        }

        if (action === "ENTRY_FILLED") {
            const updated = await recordEntryFilled(sym, entryTf, direction, entry);
            if (updated) {
                await pushLogEvent(sym, direction, `📥 FILLED: ${type} ${entryTf} @ ${entry}`, Date.now());
                broadcastAll();
            }
            return res.status(200).send("OK");
        }

        if (action === "TP_HIT") {
            const updated = await recordResult(sym, entryTf, direction, entry, 'TP_HIT');
            if (updated) {
                await pushLogEvent(sym, 'BULLISH', `🎯 TP HIT: ${type} ${entryTf} @ ${entry}`, Date.now());
                broadcastAll();
            }
            return res.status(200).send("OK");
        }

        if (action === "SL_HIT") {
            const updated = await recordResult(sym, entryTf, direction, entry, 'SL_HIT');
            if (updated) {
                await pushLogEvent(sym, 'BEARISH', `💀 SL HIT: ${type} ${entryTf} @ ${entry}`, Date.now());
                broadcastAll();
            }
            return res.status(200).send("OK");
        }

        console.warn(`[LEGACY] Unknown action: ${action}`);
        return res.status(400).send("Unknown action");
    }

    return res.status(400).send("Unknown payload");
});

// ══════════════════════════════════════════════
// FILTERED ALIGNMENT API ENDPOINTS
// ══════════════════════════════════════════════
app.get('/api/filtered-state/wdh', (req, res) => {
    const filtered = {};
    for (const sym in marketState) {
        const tfs = marketState[sym].timeframes || {};
        const w = tfs['1W'] || 'NONE';
        const d = tfs['1D'] || 'NONE';
        const h4 = tfs['4H'] || 'NONE';
        if (w !== 'NONE' && w === d && d === h4) {
            filtered[sym] = { ...marketState[sym], filterDirection: w };
        }
    }
    res.json({ marketState: filtered, activityLog });
});

app.get('/api/filtered-state/dh1h', (req, res) => {
    const filtered = {};
    for (const sym in marketState) {
        const tfs = marketState[sym].timeframes || {};
        const d = tfs['1D'] || 'NONE';
        const h4 = tfs['4H'] || 'NONE';
        const h1 = tfs['1H'] || 'NONE';
        if (d !== 'NONE' && d === h4 && h4 === h1) {
            filtered[sym] = { ...marketState[sym], filterDirection: d };
        }
    }
    res.json({ marketState: filtered, activityLog });
});

// ══════════════════════════════════════════════
// PAGE ROUTES
// ══════════════════════════════════════════════
app.get('/',      (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/stats', (req, res) => res.sendFile(path.join(__dirname, 'public', 'stats.html')));
app.get('/wdh',   (req, res) => res.sendFile(path.join(__dirname, 'public', 'wdh.html')));
app.get('/dh1h',  (req, res) => res.sendFile(path.join(__dirname, 'public', 'dh1h.html')));

// ══════════════════════════════════════════════
// START
// ══════════════════════════════════════════════
app.listen(PORT, () => {
    console.log(`\n🚀 God-Mode V6 on port ${PORT}`);
    console.log(`📊 Alignment: ${GOD_THRESHOLD}/6 = GOD, ${PARTIAL_THRESHOLD}/6 = PARTIAL (${ZONE_TIMEFRAMES.join(' + ')})`);
    console.log(`📡 Entry TFs: ${ENTRY_TFS.join(', ')}`);
    console.log(`📡 Alignment Combos: ${ALIGNMENT_COMBOS.length} tracked`);
    console.log(`📡 1M Entries: ${TG_1M_ENTRIES || 'NOT SET'}`);
    console.log(`📡 3M Entries: ${TG_3M_ENTRIES || 'NOT SET'}`);
    console.log(`📡 5M Entries: ${TG_5M_ENTRIES || 'NOT SET'}`);
    console.log(`📡 Storyline: ${TELEGRAM_STORYLINE_CHAT_ID || 'NOT SET'}`);
});
