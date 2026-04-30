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

// ═══ BREAKOUT TELEGRAM CHANNELS ═══
const TG_BREAKOUT_5OF6   = process.env.TG_BREAKOUT_5OF6;
const TG_BREAKOUT_6OF6   = process.env.TG_BREAKOUT_6OF6;
const TG_BREAKOUT_WD4H1H = process.env.TG_BREAKOUT_WD4H1H;

const REDIS_STATE_KEY     = process.env.REDIS_KEY || 'godModeState_v4';
const REDIS_LOG_KEY       = REDIS_STATE_KEY + '_activityLog';
const REDIS_STATS_KEY     = REDIS_STATE_KEY + '_tradeStats';

const ZONE_TIMEFRAMES     = ["1W", "1D", "4H", "1H", "30M", "15M"];
const GOD_THRESHOLD       = 6;
const PARTIAL_THRESHOLD   = 5;
const ENTRY_TFS           = ["1M", "3M", "5M"];

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

// ═══ NEW: Check if W+D+4H+1H are all aligned in same direction ═══
function checkWD4H1HAlignment(symbol, direction) {
    if (!marketState[symbol]) return false;
    const tfs = marketState[symbol].timeframes || {};
    return ['1W','1D','4H','1H'].every(tf => tfs[tf] === direction);
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

// ══════════════════════════════════════════════
// API ROUTES
// ══════════════════════════════════════════════
app.get('/api/state', (req, res) => res.json({ marketState, activityLog }));
app.get('/api/stats', (req, res) => res.json({ tradeStats: buildEnrichedStats(), alignmentCombos: ALIGNMENT_COMBOS }));

app.get('/api/stream', (req, res) => {
    res.setHeader('Content-Type','text/event-stream');
    res.setHeader('Cache-Control','no-cache');
    res.setHeader('Connection','keep-alive');
    res.setHeader('X-Accel-Buffering','no');
    res.flushHeaders();
    const id = Date.now();
    clients.push({ id, res });
    const ka = setInterval(() => res.write(': keepalive\n\n'), 15000);
    req.on('close', () => { clearInterval(ka); clients = clients.filter(c => c.id !== id); });
});

app.get('/api/stats-stream', (req, res) => {
    res.setHeader('Content-Type','text/event-stream');
    res.setHeader('Cache-Control','no-cache');
    res.setHeader('Connection','keep-alive');
    res.setHeader('X-Accel-Buffering','no');
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
    await pushLogEvent(sym, 'SYSTEM', '🗑️ Purged');
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
    const isStoryline  = payload.state !== undefined && payload.tf !== undefined && payload.coin === undefined && payload.action === undefined && payload.kind === undefined;
    const isBreakout   = payload.kind === "BREAKOUT";
    const isPineEntry  = payload.coin !== undefined && payload.action !== undefined && payload.kind === undefined;

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
        if (!marketState[sym].timeframes) {
            marketState[sym].timeframes = {};
            ZONE_TIMEFRAMES.forEach(t => marketState[sym].timeframes[t] = "NONE");
        }

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

        if (!sym || !direction) {
            console.log(`[BREAKOUT] Invalid payload — missing symbol or direction`);
            return res.status(400).send("Invalid Breakout Payload");
        }

        console.log(`\n[BREAKOUT] ${sym} | ${direction} | Chart TF: ${chartTf}`);

        // ─── Step 1: Check alignment ───
        const align = checkDirectionAlignment(sym, direction);

        if (!align.aligned) {
            console.log(`  ❌ BREAKOUT IGNORED: ${sym} ${direction} | ${align.reason}`);
            return res.status(200).send("OK — Not aligned");
        }

        console.log(`  ✅ BREAKOUT ALIGNED [${align.type}] (${align.count}/6)`);

        // ─── Step 2: Build Telegram message ───
        const dirEmoji    = direction === "BULLISH" ? "🚀 🐂" : "🩸 🐻";
        const alignEmoji  = align.type === 'GOD' ? '✅' : '⚡';
        const alignLabel  = align.type === 'GOD' ? `GOD-MODE (6/6)` : `PARTIAL (${align.count}/6)`;
        const chartTfStr  = chartTf || payload.chart_tf || '?';

        let tgMsg = `<b>${dirEmoji} BREAKOUT: ${sym}</b>\n\n`;
        tgMsg += `<b>Direction:</b> ${direction}\n`;
        tgMsg += `<b>Chart TF:</b> ${chartTfStr}\n`;
        tgMsg += `\n${alignEmoji} <b>${alignLabel}</b>\n`;
        tgMsg += `${tfInfoString(sym)}`;

        // ─── Step 3: Route to correct Telegram channels ───
        const sentChannels = [];

        // 5/6 channel — PARTIAL only (exactly 5, not 6)
        if (align.count === PARTIAL_THRESHOLD && align.type === 'PARTIAL') {
            if (TG_BREAKOUT_5OF6) {
                await sendTelegram(TG_BREAKOUT_5OF6, tgMsg);
                sentChannels.push('5/6');
                console.log(`  📡 Sent to 5/6 breakout channel`);
            } else {
                console.log(`  ⚠️ TG_BREAKOUT_5OF6 not configured`);
            }
        }

        // 6/6 channel — GOD mode only
        if (align.type === 'GOD') {
            if (TG_BREAKOUT_6OF6) {
                await sendTelegram(TG_BREAKOUT_6OF6, tgMsg);
                sentChannels.push('6/6');
                console.log(`  📡 Sent to 6/6 breakout channel`);
            } else {
                console.log(`  ⚠️ TG_BREAKOUT_6OF6 not configured`);
            }
        }

        // W+D+4H+1H channel — all 4 TFs same direction (regardless of 5/6 or 6/6)
        const isWD4H1H = checkWD4H1HAlignment(sym, direction);
        if (isWD4H1H) {
            if (TG_BREAKOUT_WD4H1H) {
                await sendTelegram(TG_BREAKOUT_WD4H1H, tgMsg);
                sentChannels.push('W+D+4H+1H');
                console.log(`  📡 Sent to W+D+4H+1H breakout channel`);
            } else {
                console.log(`  ⚠️ TG_BREAKOUT_WD4H1H not configured`);
            }
        }

        // ─── Step 4: Log to activity feed ───
        const channelStr = sentChannels.length > 0 ? ` → [${sentChannels.join(', ')}]` : '';
        await pushLogEvent(
            sym,
            direction,
            `💥 BREAKOUT: ${direction} | Chart:${chartTfStr} | ${alignLabel}${channelStr}`,
            { logAction: 'BREAKOUT', direction, chart_tf: chartTfStr, align_type: align.type, align_count: align.count }
        );

        // ─── Step 5: Broadcast to webpage ───
        broadcastAll();
        broadcastSoundAlert(sym, direction);

        console.log(`  ✅ Breakout processed: ${sym} ${direction} | Channels: ${sentChannels.join(', ') || 'none'}`);
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

        if (!ENTRY_TFS.includes(entryTf)) {
            console.log(`[PINE ${action}] ${sym} | TF:${entryTf} — IGNORED`);
            return res.status(200).send("OK — TF not accepted");
        }

        console.log(`\n[PINE ${action}] ${sym} | ${direction} | TF:${entryTf} | Entry:${entry} | SL:${sl} | TP:${tp}`);

        if (action === "OB_FORMED") {
            const align = checkDirectionAlignment(sym, direction);
            if (!align.aligned) {
                console.log(`  ❌ REJECTED: ${sym} ${direction} ${entryTf} | ${align.reason}`);
                return res.status(200).send("OK — Not aligned");
            }

            console.log(`  ✅ ALIGNED [${align.type}] (${align.count}/6) | Combos: ${align.combos.join(',')}`);

            const stats = ensureStats(sym, entryTf);
            stats.total_signals++;

            const trade = {
                id: makeTradeId(sym, entryTf),
                direction,
                entry:        parseFloat(entry) || entry,
                sl:           parseFloat(sl) || sl,
                tp:           parseFloat(tp) || tp,
                rr:           parseFloat(rr) || rr,
                alignment:    align.type,
                align_combos: align.combos,
                align_count:  align.count,
                status:       'PENDING',
                signal_time:  Date.now(),
                entry_time:   null,
                result_time:  null,
                entry_tf:     entryTf,
                telegram_chat_id: null, telegram_message_id: null, telegram_deleted: false,
                cancelled_time: null, cancelled_reason: null
            };
            stats.trades.push(trade);
            if (stats.trades.length > 500) stats.trades = stats.trades.slice(-500);

            const chatId = TG_CHANNEL_MAP[entryTf]?.();
            let soundTriggered = false;
            if (chatId) {
                const alignLabel = align.type === 'GOD' ? 'GOD-MODE (6/6)' : `PARTIAL (${align.count}/6)`;
                const dirEmoji = direction === "BULLISH" ? "🟢 🐂" : "🔴 🐻";
                let msg = `<b>${dirEmoji} ${entryTf} OB SIGNAL: ${sym}</b>\n\n`;
                msg += `<b>Entry:</b> <code>${entry}</code>\n<b>SL:</b> <code>${sl}</code>\n`;
                if (tp) msg += `<b>TP:</b> <code>${tp}</code>\n`;
                if (rr) msg += `<b>R:R:</b> ${rr}\n`;
                msg += `\n${align.type === 'GOD' ? '✅' : '⚡'} <b>${alignLabel}</b>\n${tfInfoString(sym)}`;

                const sent = await sendTelegramTracked(chatId, msg);
                if (sent.ok) {
                    soundTriggered = true;
                    trade.telegram_chat_id = chatId;
                    trade.telegram_message_id = sent.messageId;
                }
            }

            await saveStats();
            broadcastStats();
            if (soundTriggered) broadcastSoundAlert(sym, direction);
            await pushLogEvent(sym, direction, `📡 OB SIGNAL: ${direction} ${entryTf} @ ${entry} [${align.type} ${align.count}/6]`, { entry_tf: entryTf, direction, logAction: 'SIGNAL' });
            broadcastAll();
            return res.status(200).send("OK");
        }

        if (action === "ENTRY_DONE") {
            const stats = tradeStats[sym]?.[entryTf];
            if (!stats) { console.log(`  ⚠️ No stats for ${sym} ${entryTf}`); return res.status(200).send("OK"); }
            const found = findBestTrade(stats, { direction, entry, allowedStatuses: ['PENDING'] });
            if (found) {
                found.trade.status = 'ACTIVE';
                found.trade.entry_time = Date.now();
                console.log(`  ✅ ENTRY FILLED: ${found.trade.id}`);
                await saveStats();
                broadcastStats();
                await pushLogEvent(sym, direction, `📥 ENTRY FILLED: ${direction} ${entryTf} @ ${entry}`, { entry_tf: entryTf, direction, logAction: 'ENTRY_FILLED' });
                broadcastAll();
            } else {
                console.log(`  ⚠️ No PENDING trade for ${sym} ${entryTf} ${direction} @ ${entry}`);
            }
            return res.status(200).send("OK");
        }

        if (action === "ENTRY_AND_SL_HIT") {
            const stats = tradeStats[sym]?.[entryTf];
            if (!stats) { console.log(`  ⚠️ No stats for ${sym} ${entryTf}`); return res.status(200).send("OK"); }
            const found = findBestTrade(stats, { direction, entry, allowedStatuses: ['PENDING'] });
            if (found) {
                found.trade.status = 'SL_HIT';
                found.trade.entry_time = Date.now();
                found.trade.result_time = Date.now();
                console.log(`  💀 ENTRY+SL HIT: ${found.trade.id}`);
                await saveStats();
                broadcastStats();
                await pushLogEvent(sym, 'BEARISH', `💀 ENTRY+SL HIT: ${direction} ${entryTf} @ ${entry}`, { entry_tf: entryTf, direction, logAction: 'SL_HIT' });
                broadcastAll();
            } else {
                console.log(`  ⚠️ No PENDING trade for ENTRY+SL: ${sym} ${entryTf} ${direction}`);
            }
            return res.status(200).send("OK");
        }

        if (action === "ENTRY_AND_TP_HIT") {
            const stats = tradeStats[sym]?.[entryTf];
            if (!stats) { console.log(`  ⚠️ No stats for ${sym} ${entryTf}`); return res.status(200).send("OK"); }
            const found = findBestTrade(stats, { direction, entry, allowedStatuses: ['PENDING'] });
            if (found) {
                found.trade.status = 'TP_HIT';
                found.trade.entry_time = Date.now();
                found.trade.result_time = Date.now();
                console.log(`  🎯 ENTRY+TP HIT: ${found.trade.id}`);
                await saveStats();
                broadcastStats();
                await pushLogEvent(sym, 'BULLISH', `🎯 ENTRY+TP HIT: ${direction} ${entryTf} @ ${entry}`, { entry_tf: entryTf, direction, logAction: 'TP_HIT' });
                broadcastAll();
            } else {
                console.log(`  ⚠️ No PENDING trade for ENTRY+TP: ${sym} ${entryTf} ${direction}`);
            }
            return res.status(200).send("OK");
        }

        if (action === "TP_HIT") {
            const stats = tradeStats[sym]?.[entryTf];
            if (!stats) { console.log(`  ⚠️ No stats for ${sym} ${entryTf}`); return res.status(200).send("OK"); }

            const foundActive = findBestTrade(stats, { direction, entry, allowedStatuses: ['ACTIVE'] });
            if (foundActive) {
                foundActive.trade.status = 'TP_HIT';
                foundActive.trade.result_time = Date.now();
                console.log(`  🎯 TP HIT: ${foundActive.trade.id}`);
                await saveStats();
                broadcastStats();
                await pushLogEvent(sym, 'BULLISH', `🎯 TP HIT: ${direction} ${entryTf} @ ${entry}`, { entry_tf: entryTf, direction, logAction: 'TP_HIT' });
                broadcastAll();
                return res.status(200).send("OK");
            }

            const foundPending = findBestTrade(stats, { direction, entry, allowedStatuses: ['PENDING'] });
            if (foundPending) {
                foundPending.trade.status = 'TP_NO_ENTRY';
                foundPending.trade.result_time = Date.now();
                console.log(`  ⏭️ TP without entry: ${foundPending.trade.id} — NOT counted`);
                await saveStats();
                broadcastStats();
                await pushLogEvent(sym, 'NONE', `⏭️ TP without entry: ${direction} ${entryTf} @ ${entry} — skipped`, { entry_tf: entryTf, direction, logAction: 'TP_NO_ENTRY' });
                broadcastAll();
            } else {
                console.log(`  ⚠️ TP_HIT — no trade found for ${sym} ${entryTf} ${direction}`);
            }
            return res.status(200).send("OK");
        }

        if (action === "SL_HIT") {
            const stats = tradeStats[sym]?.[entryTf];
            if (!stats) { console.log(`  ⚠️ No stats for ${sym} ${entryTf}`); return res.status(200).send("OK"); }

            const foundActive = findBestTrade(stats, { direction, entry, allowedStatuses: ['ACTIVE'] });
            if (foundActive) {
                foundActive.trade.status = 'SL_HIT';
                foundActive.trade.result_time = Date.now();
                console.log(`  💀 SL HIT: ${foundActive.trade.id}`);
                await saveStats();
                broadcastStats();
                await pushLogEvent(sym, 'BEARISH', `💀 SL HIT: ${direction} ${entryTf} @ ${entry}`, { entry_tf: entryTf, direction, logAction: 'SL_HIT' });
                broadcastAll();
                return res.status(200).send("OK");
            }

            const foundPending = findBestTrade(stats, { direction, entry, allowedStatuses: ['PENDING'] });
            if (foundPending) {
                foundPending.trade.status = 'SL_NO_ENTRY';
                foundPending.trade.result_time = Date.now();
                console.log(`  ⏭️ SL without entry: ${foundPending.trade.id} — NOT counted`);
                await saveStats();
                broadcastStats();
                await pushLogEvent(sym, 'NONE', `⏭️ SL without entry: ${direction} ${entryTf} @ ${entry} — skipped`, { entry_tf: entryTf, direction, logAction: 'SL_NO_ENTRY' });
                broadcastAll();
            } else {
                console.log(`  ⚠️ SL_HIT — no trade found for ${sym} ${entryTf} ${direction}`);
            }
            return res.status(200).send("OK");
        }

        console.warn(`[PINE] Unknown action: ${action}`);
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

// ══════════════════════════════════════════════
// START
// ══════════════════════════════════════════════
app.listen(PORT, () => {
    console.log(`\n🚀 God-Mode V6 on port ${PORT}`);
    console.log(`📊 Alignment: ${GOD_THRESHOLD}/6 = GOD, ${PARTIAL_THRESHOLD}/6 = PARTIAL`);
    console.log(`📡 Entry TFs: ${ENTRY_TFS.join(', ')}`);
    console.log(`📡 Combos: ${ALIGNMENT_COMBOS.length} tracked`);
    console.log(`📡 Breakout 5/6:    ${TG_BREAKOUT_5OF6   || 'NOT SET'}`);
    console.log(`📡 Breakout 6/6:    ${TG_BREAKOUT_6OF6   || 'NOT SET'}`);
    console.log(`📡 Breakout W+D+4H+1H: ${TG_BREAKOUT_WD4H1H || 'NOT SET'}`);
});
