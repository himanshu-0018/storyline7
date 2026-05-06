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

const TG_BREAKOUT_5OF6    = process.env.TG_BREAKOUT_5OF6;
const TG_BREAKOUT_6OF6    = process.env.TG_BREAKOUT_6OF6;
const TG_BREAKOUT_WD4H1H  = process.env.TG_BREAKOUT_WD4H1H;
const TG_CUSTOM_ALIGNMENT = process.env.TG_CUSTOM_ALIGNMENT;

const REDIS_STATE_KEY     = process.env.REDIS_KEY || 'godModeState_v4';
const REDIS_LOG_KEY       = REDIS_STATE_KEY + '_activityLog';
const REDIS_STATS_KEY     = REDIS_STATE_KEY + '_tradeStats';
const REDIS_SETTINGS_KEY  = REDIS_STATE_KEY + '_settings';
const REDIS_CRT_KEY       = REDIS_STATE_KEY + '_crt';

const ZONE_TIMEFRAMES = ["1W", "1D", "4H", "1H", "30M", "15M"];
const GOD_THRESHOLD   = 6;
const PARTIAL_THRESHOLD = 5;
const ENTRY_TFS       = ["1M", "3M", "5M"];
const CRT_VALID_TFS   = ["1W", "1D", "4H"];

const TG_CHANNEL_MAP = {
    "1M": () => TG_1M_ENTRIES,
    "3M": () => TG_3M_ENTRIES,
    "5M": () => TG_5M_ENTRIES
};

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
let appSettings  = { activeAlignments: [] };
// crtState structure: { BTCUSDT: { "1W": [...], "1D": [...], "4H": [...] } }
// Each TF holds an ARRAY of CRT entries to support multiple simultaneous CRTs
let crtState     = {};
let crtLog       = [];
let clients      = [];
let statsClients = [];
let crtClients   = [];

// ══════════════════════════════════════════════
// BROADCAST
// ══════════════════════════════════════════════
function broadcastAll(extras = {}) {
    const data = JSON.stringify({ marketState, activityLog, settings: appSettings, ...extras });
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
function broadcastCRT() {
    const data = JSON.stringify({ crtState, crtLog });
    crtClients.forEach(c => c.res.write(`data: ${data}\n\n`));
}
function broadcastCRTSound(symbol, side) {
    const data = JSON.stringify({ crtSound: true, symbol, side });
    crtClients.forEach(c => c.res.write(`data: ${data}\n\n`));
}

// ══════════════════════════════════════════════
// TELEGRAM
// ══════════════════════════════════════════════
async function sendTelegramTracked(chatId, message) {
    if (!TELEGRAM_TOKEN || !chatId) return { ok: false, messageId: null };
    try {
        const resp = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
            { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ chat_id:chatId, text:message, parse_mode:"HTML" }) });
        if (!resp.ok) return { ok: false, messageId: null };
        const data = await resp.json();
        return { ok: true, messageId: data?.result?.message_id || null };
    } catch (err) { console.error("TG Send Error:", err); return { ok: false, messageId: null }; }
}
async function deleteTelegramMessage(chatId, messageId) {
    if (!TELEGRAM_TOKEN || !chatId || !messageId) return false;
    try {
        const resp = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/deleteMessage`,
            { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ chat_id:chatId, message_id:messageId }) });
        return resp.ok;
    } catch (err) { console.error("TG Delete Error:", err); return false; }
}
async function sendTelegram(chatId, message) {
    if (!TELEGRAM_TOKEN || !chatId) return false;
    try {
        const resp = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
            { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ chat_id:chatId, text:message, parse_mode:"HTML" }) });
        return resp.ok;
    } catch (err) { console.error("TG Error:", err); return false; }
}

// ══════════════════════════════════════════════
// ACTIVITY LOG
// ══════════════════════════════════════════════
async function pushLogEvent(symbol, type, message, extra = {}, timestamp = null) {
    const ts = timestamp || Date.now();
    const isDup = activityLog.some(e =>
        e.symbol === symbol && e.type === type && Math.abs((e.timestamp||0) - ts) < 5000
    );
    if (isDup) return;
    activityLog.unshift({ symbol, type, message, timestamp: ts, ...extra });
    if (activityLog.length > 200) activityLog = activityLog.slice(0, 200);
    await redisClient.set(REDIS_LOG_KEY, JSON.stringify(activityLog));
}

// ══════════════════════════════════════════════
// CRT LOG
// ══════════════════════════════════════════════
async function pushCRTLog(symbol, side, message, extra = {}) {
    const ts = Date.now();
    const isDup = crtLog.some(e =>
        e.symbol === symbol && e.message === message && Math.abs((e.timestamp||0) - ts) < 5000
    );
    if (isDup) return;
    crtLog.unshift({ symbol, side, message, timestamp: ts, ...extra });
    if (crtLog.length > 200) crtLog = crtLog.slice(0, 200);
    await redisClient.set(REDIS_CRT_KEY + '_log', JSON.stringify(crtLog));
}

// ══════════════════════════════════════════════
// CRT ARRAY HELPERS
// ══════════════════════════════════════════════
function makeCRTId(sym, tf) {
    return `${sym}_${tf}_${Date.now()}_${Math.random().toString(36).slice(2,6)}`;
}

// Ensure TF value is always an array
function ensureCRTArray(sym, tf) {
    if (!crtState[sym]) crtState[sym] = {};
    if (!Array.isArray(crtState[sym][tf])) crtState[sym][tf] = [];
    return crtState[sym][tf];
}

// Migrate old single-object format → array format on boot
function migrateCRTState() {
    let migrated = false;
    for (const sym in crtState) {
        for (const tf of CRT_VALID_TFS) {
            const val = crtState[sym][tf];
            if (val && !Array.isArray(val)) {
                // Old single object → wrap in array
                if (val.side) {
                    val.id = val.id || makeCRTId(sym, tf);
                    crtState[sym][tf] = [val];
                } else {
                    crtState[sym][tf] = [];
                }
                migrated = true;
            }
        }
    }
    return migrated;
}

// ══════════════════════════════════════════════
// PRICE MATCH
// ══════════════════════════════════════════════
function priceMatch(a, b) {
    const fa = parseFloat(a), fb = parseFloat(b);
    if (isNaN(fa) || isNaN(fb)) return false;
    return Math.abs(fa - fb) <= Math.max(Math.abs(fa), Math.abs(fb)) * 0.0005;
}
function makeTradeId(symbol, tf) {
    return `${symbol}_${tf}_${Date.now()}_${Math.random().toString(36).slice(2,7)}`;
}

// ══════════════════════════════════════════════
// ALIGNMENT
// ══════════════════════════════════════════════
function getMatchedCombos(symbol, direction) {
    if (!marketState[symbol]) return [];
    const tfs = marketState[symbol].timeframes || {};
    return ALIGNMENT_COMBOS.filter(c => c.tfs.every(tf => tfs[tf] === direction)).map(c => c.id);
}
function checkDirectionAlignment(symbol, direction) {
    if (!marketState[symbol]) return { aligned: false, reason: "Not tracked" };
    const tfs = marketState[symbol].timeframes || {};
    let count = 0;
    ZONE_TIMEFRAMES.forEach(tf => { if (tfs[tf] === direction) count++; });
    if (count < PARTIAL_THRESHOLD) return { aligned: false, reason: `Only ${count}/6 aligned for ${direction}` };
    const combos = getMatchedCombos(symbol, direction);
    const type = count >= GOD_THRESHOLD ? 'GOD' : 'PARTIAL';
    return { aligned: true, type, count, combos };
}
function checkWD4H1HAlignment(symbol, direction) {
    if (!marketState[symbol]) return false;
    const tfs = marketState[symbol].timeframes || {};
    return ['1W','1D','4H','1H'].every(tf => tfs[tf] === direction);
}
function checkCustomAlignment(symbol, direction) {
    if (!marketState[symbol] || appSettings.activeAlignments.length === 0) return false;
    const tfs = marketState[symbol].timeframes || {};
    for (const comboId of appSettings.activeAlignments) {
        const combo = ALIGNMENT_COMBOS.find(c => c.id === comboId);
        if (combo && combo.tfs.every(tf => tfs[tf] === direction)) return true;
    }
    return false;
}
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
        if (bullCount >= PARTIAL_THRESHOLD) { partialState = "BULLISH"; partialCount = bullCount; }
        else if (bearCount >= PARTIAL_THRESHOLD) { partialState = "BEARISH"; partialCount = bearCount; }
    }
    marketState[symbol].alignCount = Math.max(bullCount, bearCount);
    marketState[symbol].partialState = partialState;
    marketState[symbol].partialCount = partialCount;
    return { dominantState, bullCount, bearCount, alignCount: Math.max(bullCount, bearCount), partialState, partialCount };
}
function getDirectionAlignCount(symbol, direction) {
    if (!marketState[symbol]) return 0;
    const tfs = marketState[symbol].timeframes || {};
    let count = 0;
    ZONE_TIMEFRAMES.forEach(tf => { if (tfs[tf] === direction) count++; });
    return count;
}

// ══════════════════════════════════════════════
// STATS HELPERS
// ══════════════════════════════════════════════
function ensureStats(symbol, tf) {
    if (!tradeStats[symbol]) tradeStats[symbol] = {};
    if (!tradeStats[symbol][tf]) tradeStats[symbol][tf] = { total_signals: 0, trades: [] };
    return tradeStats[symbol][tf];
}
function buildEnrichedStats() {
    const enriched = {};
    for (const sym in tradeStats) {
        enriched[sym] = {};
        for (const tf in tradeStats[sym]) {
            enriched[sym][tf] = {
                total_signals: tradeStats[sym][tf].total_signals || 0,
                trades: tradeStats[sym][tf].trades
            };
        }
    }
    return enriched;
}
async function saveStats() {
    await redisClient.set(REDIS_STATS_KEY, JSON.stringify(tradeStats));
}

// ══════════════════════════════════════════════
// TRADE FINDER
// ══════════════════════════════════════════════
function findBestTrade(stats, { direction, entry, allowedStatuses }) {
    const trades = stats.trades;
    let candidates = [];
    if (entry !== undefined && entry !== null) {
        for (let i = 0; i < trades.length; i++) {
            const t = trades[i];
            if (t.direction === direction && allowedStatuses.includes(t.status) && priceMatch(t.entry, entry))
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
// CANCEL PENDING ON ALIGNMENT DROP
// ══════════════════════════════════════════════
async function invalidatePendingTrades(symbol) {
    let totalCancelled = 0;
    for (const tf of ENTRY_TFS) {
        const stats = tradeStats[symbol]?.[tf];
        if (!stats?.trades?.length) continue;
        for (const trade of stats.trades) {
            if (trade.status !== 'PENDING') continue;
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
                await pushLogEvent(symbol, 'CANCEL', `❌ CANCELLED: ${trade.direction} ${tf} @ ${trade.entry}`, { entry_tf: tf, direction: trade.direction });
                totalCancelled++;
            }
        }
    }
    if (totalCancelled > 0) { await saveStats(); broadcastStats(); }
    return totalCancelled;
}

// ══════════════════════════════════════════════
// TF NORMALIZER
// ══════════════════════════════════════════════
function normalizeTf(tf) {
    if (!tf) return null;
    const map = {
        "1":"1M","1M":"1M","1MIN":"1M","3":"3M","3M":"3M","3MIN":"3M",
        "5":"5M","5M":"5M","5MIN":"5M","15":"15M","15M":"15M","15MIN":"15M",
        "30":"30M","30M":"30M","30MIN":"30M","60":"1H","1H":"1H","1HR":"1H",
        "240":"4H","4H":"4H","1D":"1D","D":"1D","1W":"1W","W":"1W","WEEKLY":"1W"
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
} else { console.log('🆕 No saved state'); }

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
                if (!t.entry_tf) t.entry_tf = tf;
                if (!t.align_combos) t.align_combos = [];
                if (!t.align_count) t.align_count = 0;
                if (t.status === 'SIGNAL') t.status = 'PENDING';
            });
        }
    }
    console.log(`📊 Stats for ${Object.keys(tradeStats).length} symbols`);
}

const savedSettings = await redisClient.get(REDIS_SETTINGS_KEY);
if (savedSettings) {
    appSettings = JSON.parse(savedSettings);
    console.log(`⚙️ Settings loaded: ${appSettings.activeAlignments.length} alignments active`);
} else { console.log('⚙️ No saved settings'); }

const savedCRT = await redisClient.get(REDIS_CRT_KEY);
if (savedCRT) {
    crtState = JSON.parse(savedCRT);
    // Auto-migrate old single-object format to array format
    const wasMigrated = migrateCRTState();
    if (wasMigrated) {
        await redisClient.set(REDIS_CRT_KEY, JSON.stringify(crtState));
        console.log(`🔄 CRT state migrated to array format`);
    }
    console.log(`🔄 CRT state loaded: ${Object.keys(crtState).length} symbols`);
} else { console.log('🆕 No CRT state found'); }

const savedCRTLog = await redisClient.get(REDIS_CRT_KEY + '_log');
if (savedCRTLog) {
    crtLog = JSON.parse(savedCRTLog);
    console.log(`📡 CRT log: ${crtLog.length} entries`);
}

// ══════════════════════════════════════════════
// API ROUTES
// ══════════════════════════════════════════════
app.get('/api/state', (req, res) => res.json({ marketState, activityLog, settings: appSettings }));
app.get('/api/stats', (req, res) => res.json({ tradeStats: buildEnrichedStats(), alignmentCombos: ALIGNMENT_COMBOS }));
app.get('/api/crt-state', (req, res) => res.json({ crtState, crtLog }));

app.get('/api/settings', (req, res) => {
    res.json({ settings: appSettings, alignmentCombos: ALIGNMENT_COMBOS });
});
app.post('/api/settings', async (req, res) => {
    const { activeAlignments } = req.body;
    if (!Array.isArray(activeAlignments)) return res.status(400).send("Invalid");
    const validIds = ALIGNMENT_COMBOS.map(c => c.id);
    appSettings.activeAlignments = activeAlignments.filter(id => validIds.includes(id));
    await redisClient.set(REDIS_SETTINGS_KEY, JSON.stringify(appSettings));
    console.log(`⚙️ Settings saved: ${appSettings.activeAlignments.length} alignments active`);
    broadcastAll({ settings: appSettings });
    res.json({ ok: true, settings: appSettings });
});

app.get('/api/stream', (req, res) => {
    res.setHeader('Content-Type','text/event-stream'); res.setHeader('Cache-Control','no-cache');
    res.setHeader('Connection','keep-alive'); res.setHeader('X-Accel-Buffering','no'); res.flushHeaders();
    const id = Date.now(); clients.push({ id, res });
    const ka = setInterval(() => res.write(': keepalive\n\n'), 15000);
    req.on('close', () => { clearInterval(ka); clients = clients.filter(c => c.id !== id); });
});
app.get('/api/stats-stream', (req, res) => {
    res.setHeader('Content-Type','text/event-stream'); res.setHeader('Cache-Control','no-cache');
    res.setHeader('Connection','keep-alive'); res.setHeader('X-Accel-Buffering','no'); res.flushHeaders();
    const id = Date.now(); statsClients.push({ id, res });
    const ka = setInterval(() => res.write(': keepalive\n\n'), 15000);
    req.on('close', () => { clearInterval(ka); statsClients = statsClients.filter(c => c.id !== id); });
});
app.get('/api/crt-stream', (req, res) => {
    res.setHeader('Content-Type','text/event-stream'); res.setHeader('Cache-Control','no-cache');
    res.setHeader('Connection','keep-alive'); res.setHeader('X-Accel-Buffering','no'); res.flushHeaders();
    const id = Date.now(); crtClients.push({ id, res });
    const ka = setInterval(() => res.write(': keepalive\n\n'), 15000);
    req.on('close', () => { clearInterval(ka); crtClients = crtClients.filter(c => c.id !== id); });
});

app.post('/api/delete', async (req, res) => {
    const { symbol, action } = req.body;
    if (!symbol || action !== 'DELETE') return res.status(400).send("Invalid");
    const sym = symbol.toUpperCase().trim();
    if (!marketState[sym]) return res.status(404).send("Not found");
    delete marketState[sym];
    await redisClient.set(REDIS_STATE_KEY, JSON.stringify(marketState));
    await pushLogEvent(sym, 'SYSTEM', '🗑️ Purged');
    broadcastAll(); res.send("Purged");
});
app.post('/api/delete-stats', async (req, res) => {
    const { symbol } = req.body;
    if (!symbol) return res.status(400).send("Invalid");
    const sym = symbol.toUpperCase().trim();
    if (sym === "ALL") { tradeStats = {}; }
    else { if (!tradeStats[sym]) return res.status(404).send("Not found"); delete tradeStats[sym]; }
    await saveStats(); broadcastStats(); res.send("Cleared");
});
app.post('/api/delete-crt', async (req, res) => {
    const { symbol } = req.body;
    if (!symbol) return res.status(400).send("Invalid");
    const sym = symbol.toUpperCase().trim();
    if (sym === "ALL") { crtState = {}; crtLog = []; }
    else { if (crtState[sym]) delete crtState[sym]; crtLog = crtLog.filter(e => e.symbol !== sym); }
    await redisClient.set(REDIS_CRT_KEY, JSON.stringify(crtState));
    await redisClient.set(REDIS_CRT_KEY + '_log', JSON.stringify(crtLog));
    broadcastCRT(); res.send("Cleared");
});

// ══════════════════════════════════════════════
// MAIN WEBHOOK
// ══════════════════════════════════════════════
app.post('/webhook', async (req, res) => {
    const payload = req.body;

    const isStoryline = payload.state !== undefined && payload.tf !== undefined && payload.coin === undefined && payload.action === undefined && payload.kind === undefined;
    const isBreakout  = payload.kind === "BREAKOUT";
    const isCRT       = payload.kind === "CRT" || payload.kind === "CRT_TARGET" || payload.kind === "CRT_INVALID";
    const isPineEntry = payload.coin !== undefined && payload.action !== undefined && payload.kind === undefined;

    // ════════════════════════════════════════
    // STORYLINE
    // ════════════════════════════════════════
    if (isStoryline) {
        const sym   = (payload.symbol || '').toUpperCase().trim();
        const tf    = normalizeTf(payload.tf);
        const state = (payload.state || '').toUpperCase().trim();
        if (!sym || !tf || !state) return res.status(400).send("Invalid Storyline");
        if (!ZONE_TIMEFRAMES.includes(tf)) return res.status(200).send("OK");
        console.log(`\n[STORYLINE] ${sym} | ${tf} → ${state}`);
        if (!marketState[sym]) {
            const defaultTfs = {};
            ZONE_TIMEFRAMES.forEach(t => defaultTfs[t] = "NONE");
            marketState[sym] = { timeframes: defaultTfs, lastAlertedState: "NONE", lastGodModeStartTime: null, alignCount: 0, partialState: "NONE", partialCount: 0 };
        }
        if (!marketState[sym].timeframes) { marketState[sym].timeframes = {}; ZONE_TIMEFRAMES.forEach(t => marketState[sym].timeframes[t] = "NONE"); }
        marketState[sym].timeframes[tf] = state;
        const prev = marketState[sym].lastAlertedState;
        const { dominantState, partialState, partialCount, alignCount } = recalculateAlignment(sym);
        if (dominantState !== "NONE" && dominantState !== prev) {
            marketState[sym].lastAlertedState = dominantState;
            marketState[sym].lastGodModeStartTime = Date.now();
            const emoji = dominantState === "BULLISH" ? "🚀 🐂" : "🩸 🐻";
            await sendTelegram(TELEGRAM_STORYLINE_CHAT_ID, `<b>${emoji} GOD-MODE: ${sym}</b>\n\n<b>Alignment:</b> ${dominantState} (6/6)\n${tfInfoString(sym)}\n\n✅ All 6 timeframes aligned!`);
            await pushLogEvent(sym, dominantState, `GOD-MODE ON: ${dominantState} (6/6)`);
        }
        if (dominantState === "NONE" && prev !== "NONE") {
            marketState[sym].lastAlertedState = "NONE";
            await sendTelegram(TELEGRAM_STORYLINE_CHAT_ID, `<b>⚠️ ALIGNMENT LOST: ${sym}</b>\n\nWas: ${prev} (6/6)\nNow: ${partialState !== "NONE" ? partialState + ` (${partialCount}/6)` : `${alignCount}/6`}\n${tfInfoString(sym)}`);
            await pushLogEvent(sym, 'NONE', `Alignment Lost: was ${prev} (6/6)`);
        }
        if (dominantState === "NONE" && partialState !== "NONE") {
            const prevPartial = marketState[sym]._lastPartialState || "NONE";
            if (prevPartial !== partialState || (prev !== "NONE" && dominantState === "NONE")) {
                const emoji = partialState === "BULLISH" ? "⚡ 🐂" : "⚡ 🐻";
                await sendTelegram(TELEGRAM_STORYLINE_CHAT_ID, `<b>${emoji} PARTIAL: ${sym}</b>\n\n<b>Alignment:</b> ${partialState} (${partialCount}/6)\n${tfInfoString(sym)}`);
                await pushLogEvent(sym, partialState, `PARTIAL: ${partialState} (${partialCount}/6)`);
            }
        }
        marketState[sym]._lastPartialState = partialState;
        await invalidatePendingTrades(sym);
        await redisClient.set(REDIS_STATE_KEY, JSON.stringify(marketState));
        broadcastAll();
        return res.status(200).send("OK");
    }

    // ════════════════════════════════════════
    // BREAKOUT ALERT
    // ════════════════════════════════════════
    if (isBreakout) {
        const sym       = (payload.symbol    || '').toUpperCase().trim();
        const direction = (payload.direction || '').toUpperCase().trim();
        const chartTf   = normalizeTf(payload.chart_tf);
        if (!sym || !direction) return res.status(400).send("Invalid Breakout Payload");
        console.log(`\n[BREAKOUT] ${sym} | ${direction} | Chart TF: ${chartTf}`);
        const align = checkDirectionAlignment(sym, direction);
        if (!align.aligned) { console.log(`  ❌ BREAKOUT IGNORED: ${align.reason}`); return res.status(200).send("OK — Not aligned"); }
        const dirEmoji   = direction === "BULLISH" ? "🚀 🐂" : "🩸 🐻";
        const alignEmoji = align.type === 'GOD' ? '✅' : '⚡';
        const alignLabel = align.type === 'GOD' ? `GOD-MODE (6/6)` : `PARTIAL (${align.count}/6)`;
        const chartTfStr = chartTf || payload.chart_tf || '?';
        let tgMsg = `<b>${dirEmoji} BREAKOUT: ${sym}</b>\n\n<b>Direction:</b> ${direction}\n<b>Chart TF:</b> ${chartTfStr}\n\n${alignEmoji} <b>${alignLabel}</b>\n${tfInfoString(sym)}`;
        const sentChannels = [];
        if (align.count === PARTIAL_THRESHOLD && align.type === 'PARTIAL' && TG_BREAKOUT_5OF6) { await sendTelegram(TG_BREAKOUT_5OF6, tgMsg); sentChannels.push('5/6'); }
        if (align.type === 'GOD' && TG_BREAKOUT_6OF6) { await sendTelegram(TG_BREAKOUT_6OF6, tgMsg); sentChannels.push('6/6'); }
        if (checkWD4H1HAlignment(sym, direction) && TG_BREAKOUT_WD4H1H) { await sendTelegram(TG_BREAKOUT_WD4H1H, tgMsg); sentChannels.push('W+D+4H+1H'); }
        if (checkCustomAlignment(sym, direction) && TG_CUSTOM_ALIGNMENT) { await sendTelegram(TG_CUSTOM_ALIGNMENT, tgMsg); sentChannels.push('CUSTOM'); }
        const channelStr = sentChannels.length > 0 ? ` → [${sentChannels.join(', ')}]` : '';
        await pushLogEvent(sym, direction, `💥 BREAKOUT: ${direction} | Chart:${chartTfStr} | ${alignLabel}${channelStr}`, { logAction: 'BREAKOUT', direction, chart_tf: chartTfStr });
        broadcastAll(); broadcastSoundAlert(sym, direction);
        console.log(`  ✅ Breakout: ${sym} ${direction} | Channels: ${sentChannels.join(', ') || 'none'}`);
        return res.status(200).send("OK");
    }

    // ════════════════════════════════════════
    // CRT ALERTS — ARRAY-BASED per TF
    // Supports multiple simultaneous CRTs per TF per symbol
    // ════════════════════════════════════════
    if (isCRT) {
        const sym  = (payload.coin || '').toUpperCase().trim();
        const tf   = (payload.tf   || '').toUpperCase().trim();
        const side = (payload.side || '').toUpperCase().trim();
        const rej  = payload.rej  || '---';
        const bo   = payload.bo   || '---';
        const ext  = payload.ext  || '---';
        const tgt  = payload.tgt  || '---';

        if (!sym || !tf || !side) {
            console.log(`[CRT] Invalid payload — missing symbol/tf/side`);
            return res.status(400).send("Invalid CRT Payload");
        }
        if (!CRT_VALID_TFS.includes(tf)) {
            console.log(`[CRT] ${sym} | TF:${tf} — IGNORED (only 1W/1D/4H)`);
            return res.status(200).send("OK — TF not accepted");
        }

        console.log(`\n[${payload.kind}] ${sym} | ${tf} | ${side} | Rej:${rej} BO:${bo} Ext:${ext} Tgt:${tgt}`);

        // Get or create the array for this TF
        const arr = ensureCRTArray(sym, tf);
        const dirEmoji = side === 'BULLISH' ? '🐂' : '🐻';

        // ── CRT FORMED → push new ACTIVE entry to array ──
        if (payload.kind === 'CRT') {
            const newEntry = {
                id:        makeCRTId(sym, tf),
                side,
                rej, bo, ext, tgt,
                status:    'ACTIVE',
                timestamp: Date.now(),
                tp_time:   null,
                inv_time:  null
            };
            arr.push(newEntry);
            // Cap at 20 entries per TF to prevent unbounded growth
            if (arr.length > 20) crtState[sym][tf] = arr.slice(-20);

            const logMsg = `${dirEmoji} ${tf} CRT FORMED: ${side} | Rej:${rej} BO:${bo} Tgt:${tgt}`;
            await pushCRTLog(sym, side, logMsg, { tf, rej, bo, ext, tgt, action: 'CRT_FORMED' });
            console.log(`  ✅ CRT ACTIVE: ${sym} ${tf} ${side} (now ${crtState[sym][tf].length} in ${tf})`);
            // Play sound only on new CRT formed
            broadcastCRTSound(sym, side);
        }

        // ── CRT_TARGET → find oldest ACTIVE with same side → TP_HIT (FIFO) ──
        if (payload.kind === 'CRT_TARGET') {
            const found = arr.find(c => c.status === 'ACTIVE' && c.side === side);
            if (found) {
                found.status  = 'TP_HIT';
                found.tp_time = Date.now();
                found.rej = rej; found.bo = bo; found.ext = ext; found.tgt = tgt;
                console.log(`  🎯 CRT TP HIT: ${sym} ${tf} ${side} | ID:${found.id}`);
            } else {
                // No matching ACTIVE → create as TP_HIT
                arr.push({ id: makeCRTId(sym, tf), side, rej, bo, ext, tgt, status: 'TP_HIT', timestamp: Date.now(), tp_time: Date.now(), inv_time: null });
                if (arr.length > 20) crtState[sym][tf] = arr.slice(-20);
                console.log(`  🎯 CRT TP HIT (no active found): ${sym} ${tf} ${side}`);
            }
            await pushCRTLog(sym, side, `🎯 ${tf} CRT TARGET HIT: ${side} | Tgt:${tgt}`, { tf, tgt, action: 'CRT_TARGET' });
        }

        // ── CRT_INVALID → find oldest ACTIVE with same side → INVALID (FIFO) ──
        if (payload.kind === 'CRT_INVALID') {
            const found = arr.find(c => c.status === 'ACTIVE' && c.side === side);
            if (found) {
                found.status   = 'INVALID';
                found.inv_time = Date.now();
                found.rej = rej; found.bo = bo; found.ext = ext; found.tgt = tgt;
                console.log(`  ❌ CRT INVALID: ${sym} ${tf} ${side} | ID:${found.id}`);
            } else {
                // No matching ACTIVE → create as INVALID
                arr.push({ id: makeCRTId(sym, tf), side, rej, bo, ext, tgt, status: 'INVALID', timestamp: Date.now(), tp_time: null, inv_time: Date.now() });
                if (arr.length > 20) crtState[sym][tf] = arr.slice(-20);
                console.log(`  ❌ CRT INVALID (no active found): ${sym} ${tf} ${side}`);
            }
            await pushCRTLog(sym, side, `❌ ${tf} CRT INVALIDATED: ${side} | Ext:${ext}`, { tf, ext, action: 'CRT_INVALID' });
        }

        await redisClient.set(REDIS_CRT_KEY, JSON.stringify(crtState));
        broadcastCRT();
        return res.status(200).send("OK");
    }

    // ════════════════════════════════════════
    // PINESCRIPT OB ALERTS
    // ════════════════════════════════════════
    if (isPineEntry) {
        const sym       = (payload.coin || '').toUpperCase().trim();
        const direction = (payload.direction || '').toUpperCase().trim();
        const entry     = payload.entry;
        const sl        = payload.sl;
        const tp        = payload.tp;
        const rr        = payload.rr;
        const action    = (payload.action || '').toUpperCase().trim();
        const entryTf   = normalizeTf(payload.chart_tf);
        if (!sym || !direction || entry === undefined) return res.status(400).send("Invalid Pine Payload");
        if (!ENTRY_TFS.includes(entryTf)) { console.log(`[PINE ${action}] ${sym} | TF:${entryTf} — IGNORED`); return res.status(200).send("OK — TF not accepted"); }
        console.log(`\n[PINE ${action}] ${sym} | ${direction} | TF:${entryTf} | Entry:${entry}`);

        if (action === "OB_FORMED") {
            const align = checkDirectionAlignment(sym, direction);
            if (!align.aligned) { console.log(`  ❌ REJECTED: ${align.reason}`); return res.status(200).send("OK — Not aligned"); }
            const stats = ensureStats(sym, entryTf);
            stats.total_signals++;
            const trade = {
                id: makeTradeId(sym, entryTf), direction,
                entry: parseFloat(entry)||entry, sl: parseFloat(sl)||sl, tp: parseFloat(tp)||tp, rr: parseFloat(rr)||rr,
                alignment: align.type, align_combos: align.combos, align_count: align.count,
                status: 'PENDING', signal_time: Date.now(), entry_time: null, result_time: null, entry_tf: entryTf,
                telegram_chat_id: null, telegram_message_id: null, telegram_deleted: false, cancelled_time: null, cancelled_reason: null
            };
            stats.trades.push(trade);
            if (stats.trades.length > 500) stats.trades = stats.trades.slice(-500);
            const chatId = TG_CHANNEL_MAP[entryTf]?.();
            let soundTriggered = false;
            if (chatId) {
                const alignLabel = align.type === 'GOD' ? 'GOD-MODE (6/6)' : `PARTIAL (${align.count}/6)`;
                const dirEmoji = direction === "BULLISH" ? "🟢 🐂" : "🔴 🐻";
                let msg = `<b>${dirEmoji} ${entryTf} OB SIGNAL: ${sym}</b>\n\n<b>Entry:</b> <code>${entry}</code>\n<b>SL:</b> <code>${sl}</code>\n`;
                if (tp) msg += `<b>TP:</b> <code>${tp}</code>\n`;
                if (rr) msg += `<b>R:R:</b> ${rr}\n`;
                msg += `\n${align.type === 'GOD' ? '✅' : '⚡'} <b>${alignLabel}</b>\n${tfInfoString(sym)}`;
                const sent = await sendTelegramTracked(chatId, msg);
                if (sent.ok) { soundTriggered = true; trade.telegram_chat_id = chatId; trade.telegram_message_id = sent.messageId; }
            }
            await saveStats(); broadcastStats();
            if (soundTriggered) broadcastSoundAlert(sym, direction);
            await pushLogEvent(sym, direction, `📡 OB SIGNAL: ${direction} ${entryTf} @ ${entry} [${align.type} ${align.count}/6]`, { entry_tf: entryTf, direction, logAction: 'SIGNAL' });
            broadcastAll();
            return res.status(200).send("OK");
        }

        if (action === "ENTRY_DONE") {
            const stats = tradeStats[sym]?.[entryTf];
            if (!stats) return res.status(200).send("OK");
            const found = findBestTrade(stats, { direction, entry, allowedStatuses: ['PENDING'] });
            if (found) { found.trade.status = 'ACTIVE'; found.trade.entry_time = Date.now(); await saveStats(); broadcastStats(); await pushLogEvent(sym, direction, `📥 ENTRY FILLED: ${direction} ${entryTf} @ ${entry}`, { entry_tf: entryTf, direction, logAction: 'ENTRY_FILLED' }); broadcastAll(); }
            return res.status(200).send("OK");
        }
        if (action === "ENTRY_AND_SL_HIT") {
            const stats = tradeStats[sym]?.[entryTf];
            if (!stats) return res.status(200).send("OK");
            const found = findBestTrade(stats, { direction, entry, allowedStatuses: ['PENDING'] });
            if (found) { found.trade.status = 'SL_HIT'; found.trade.entry_time = Date.now(); found.trade.result_time = Date.now(); await saveStats(); broadcastStats(); await pushLogEvent(sym, 'BEARISH', `💀 ENTRY+SL HIT: ${direction} ${entryTf} @ ${entry}`, { entry_tf: entryTf, direction, logAction: 'SL_HIT' }); broadcastAll(); }
            return res.status(200).send("OK");
        }
        if (action === "ENTRY_AND_TP_HIT") {
            const stats = tradeStats[sym]?.[entryTf];
            if (!stats) return res.status(200).send("OK");
            const found = findBestTrade(stats, { direction, entry, allowedStatuses: ['PENDING'] });
            if (found) { found.trade.status = 'TP_HIT'; found.trade.entry_time = Date.now(); found.trade.result_time = Date.now(); await saveStats(); broadcastStats(); await pushLogEvent(sym, 'BULLISH', `🎯 ENTRY+TP HIT: ${direction} ${entryTf} @ ${entry}`, { entry_tf: entryTf, direction, logAction: 'TP_HIT' }); broadcastAll(); }
            return res.status(200).send("OK");
        }
        if (action === "TP_HIT") {
            const stats = tradeStats[sym]?.[entryTf];
            if (!stats) return res.status(200).send("OK");
            const foundActive = findBestTrade(stats, { direction, entry, allowedStatuses: ['ACTIVE'] });
            if (foundActive) { foundActive.trade.status = 'TP_HIT'; foundActive.trade.result_time = Date.now(); await saveStats(); broadcastStats(); await pushLogEvent(sym, 'BULLISH', `🎯 TP HIT: ${direction} ${entryTf} @ ${entry}`, { entry_tf: entryTf, direction, logAction: 'TP_HIT' }); broadcastAll(); return res.status(200).send("OK"); }
            const foundPending = findBestTrade(stats, { direction, entry, allowedStatuses: ['PENDING'] });
            if (foundPending) { foundPending.trade.status = 'TP_NO_ENTRY'; foundPending.trade.result_time = Date.now(); await saveStats(); broadcastStats(); await pushLogEvent(sym, 'NONE', `⏭️ TP without entry: ${direction} ${entryTf} @ ${entry}`, { entry_tf: entryTf, direction, logAction: 'TP_NO_ENTRY' }); broadcastAll(); }
            return res.status(200).send("OK");
        }
        if (action === "SL_HIT") {
            const stats = tradeStats[sym]?.[entryTf];
            if (!stats) return res.status(200).send("OK");
            const foundActive = findBestTrade(stats, { direction, entry, allowedStatuses: ['ACTIVE'] });
            if (foundActive) { foundActive.trade.status = 'SL_HIT'; foundActive.trade.result_time = Date.now(); await saveStats(); broadcastStats(); await pushLogEvent(sym, 'BEARISH', `💀 SL HIT: ${direction} ${entryTf} @ ${entry}`, { entry_tf: entryTf, direction, logAction: 'SL_HIT' }); broadcastAll(); return res.status(200).send("OK"); }
            const foundPending = findBestTrade(stats, { direction, entry, allowedStatuses: ['PENDING'] });
            if (foundPending) { foundPending.trade.status = 'SL_NO_ENTRY'; foundPending.trade.result_time = Date.now(); await saveStats(); broadcastStats(); await pushLogEvent(sym, 'NONE', `⏭️ SL without entry: ${direction} ${entryTf} @ ${entry}`, { entry_tf: entryTf, direction, logAction: 'SL_NO_ENTRY' }); broadcastAll(); }
            return res.status(200).send("OK");
        }

        return res.status(400).send("Unknown action");
    }

    return res.status(400).send("Unknown payload");
});

// ══════════════════════════════════════════════
// FILTERED ALIGNMENT API
// ══════════════════════════════════════════════
app.get('/api/filtered-state/wdh', (req, res) => {
    const filtered = {};
    for (const sym in marketState) {
        const tfs = marketState[sym].timeframes || {};
        const w = tfs['1W']||'NONE', d = tfs['1D']||'NONE', h4 = tfs['4H']||'NONE';
        if (w !== 'NONE' && w === d && d === h4) filtered[sym] = { ...marketState[sym], filterDirection: w };
    }
    res.json({ marketState: filtered, activityLog });
});
app.get('/api/filtered-state/dh1h', (req, res) => {
    const filtered = {};
    for (const sym in marketState) {
        const tfs = marketState[sym].timeframes || {};
        const d = tfs['1D']||'NONE', h4 = tfs['4H']||'NONE', h1 = tfs['1H']||'NONE';
        if (d !== 'NONE' && d === h4 && h4 === h1) filtered[sym] = { ...marketState[sym], filterDirection: d };
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
app.get('/crt',   (req, res) => res.sendFile(path.join(__dirname, 'public', 'crt.html')));

// ══════════════════════════════════════════════
// START
// ══════════════════════════════════════════════
app.listen(PORT, () => {
    console.log(`\n🚀 God-Mode V6 on port ${PORT}`);
    console.log(`📊 Alignment: ${GOD_THRESHOLD}/6 = GOD, ${PARTIAL_THRESHOLD}/6 = PARTIAL`);
    console.log(`📡 Entry TFs: ${ENTRY_TFS.join(', ')}`);
    console.log(`📡 Combos: ${ALIGNMENT_COMBOS.length} tracked`);
    console.log(`📡 Breakout 5/6:       ${TG_BREAKOUT_5OF6    || 'NOT SET'}`);
    console.log(`📡 Breakout 6/6:       ${TG_BREAKOUT_6OF6    || 'NOT SET'}`);
    console.log(`📡 Breakout W+D+4H+1H: ${TG_BREAKOUT_WD4H1H  || 'NOT SET'}`);
    console.log(`📡 Custom Alignment:   ${TG_CUSTOM_ALIGNMENT  || 'NOT SET'}`);
    console.log(`⚙️ Active Alignments:  ${appSettings.activeAlignments.length > 0 ? appSettings.activeAlignments.join(', ') : 'NONE'}`);
    console.log(`🔄 CRT symbols loaded: ${Object.keys(crtState).length}`);
});
