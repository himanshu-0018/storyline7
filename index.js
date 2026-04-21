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
    "1M": { god: process.env.TELEGRAM_1M_GOD_CHAT_ID, all: process.env.TELEGRAM_1M_ALL_CHAT_ID, label: "1 Minute" },
    "3M": { god: process.env.TELEGRAM_3M_GOD_CHAT_ID, all: process.env.TELEGRAM_3M_ALL_CHAT_ID, label: "3 Minutes" },
    "5M": { god: process.env.TELEGRAM_5M_GOD_CHAT_ID, all: process.env.TELEGRAM_5M_ALL_CHAT_ID, label: "5 Minutes" }
};

const GOD_MODE_THRESHOLD = 3;
const ALIGNED_THRESHOLD  = 2;
const REDIS_STATE_KEY    = process.env.REDIS_KEY || 'godModeState';
const REDIS_LOG_KEY      = REDIS_STATE_KEY + '_activityLog';
const REDIS_TRADES_KEY   = REDIS_STATE_KEY + '_trades';

const ZONE_TIMEFRAMES  = ["1H", "30M", "15M"];
const ENTRY_TIMEFRAMES = ["1M", "3M", "5M"];

let marketState = {};
let activityLog = [];
let tradeTracker = {};
let clients = [];

function broadcastAll() {
    const data = JSON.stringify({ marketState, activityLog, tradeTracker });
    clients.forEach(c => c.res.write(`data: ${data}\n\n`));
}

async function sendTelegram(chatId, message, context = '') {
    if (!TELEGRAM_TOKEN || !chatId) return;
    try {
        const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: "HTML" })
        });
        if (!r.ok) console.error(`TG [${context}]:`, await r.text());
    } catch (e) { console.error(`TG [${context}]:`, e.message); }
}

const sendStoryline  = msg => sendTelegram(TELEGRAM_STORYLINE_CHAT_ID, msg, 'storyline');
const sendGodEntry   = (tf, msg) => sendTelegram(TF_CHANNELS[tf]?.god, msg, `${tf}-god`);
const sendAlignEntry = (tf, msg) => sendTelegram(TF_CHANNELS[tf]?.all, msg, `${tf}-all`);

async function pushLog(symbol, type, message, ts = null) {
    const t = ts || Date.now();
    if (activityLog.some(e => e.symbol === symbol && e.type === type && Math.abs((e.timestamp || 0) - t) < 5000)) return;
    activityLog.unshift({ symbol, type, message, timestamp: t });
    if (activityLog.length > 100) activityLog = activityLog.slice(0, 100);
    await redisClient.set(REDIS_LOG_KEY, JSON.stringify(activityLog));
}

function getTracker(tf, symbol) {
    if (!tradeTracker[tf]) tradeTracker[tf] = {};
    if (!tradeTracker[tf][symbol]) {
        tradeTracker[tf][symbol] = { signals: 0, entered: 0, tp: 0, sl: 0, pending: 0, active: 0, trades: [] };
    }
    return tradeTracker[tf][symbol];
}

async function saveTracker() { await redisClient.set(REDIS_TRADES_KEY, JSON.stringify(tradeTracker)); }

function recalcCounts(tr) {
    let p = 0, a = 0, e = 0, tp = 0, sl = 0;
    tr.trades.forEach(t => {
        if (t.status === 'PENDING') p++;
        else if (t.status === 'ACTIVE') { a++; e++; }
        else if (t.status === 'TP_HIT') { tp++; e++; }
        else if (t.status === 'SL_HIT') { sl++; e++; }
    });
    tr.pending = p; tr.active = a; tr.entered = e; tr.tp = tp; tr.sl = sl; tr.signals = tr.trades.length;
}

function recalcZones(symbol) {
    const s = marketState[symbol];
    if (!s.stopLosses) s.stopLosses = { "1H": null, "30M": null, "15M": null };
    if (!s.breakouts) s.breakouts = { "1H": null, "30M": null, "15M": null };
    if (s.activeSL === undefined) s.activeSL = "N/A";
    if (s.activeBO === undefined) s.activeBO = "N/A";
    if (s.lastGodModeStartTime === undefined) s.lastGodModeStartTime = null;
    if (s.alignmentCount === undefined) s.alignmentCount = 0;

    let bc = 0, rc = 0;
    const tf = s.timeframes || {};
    ZONE_TIMEFRAMES.forEach(t => { if (tf[t] === "BULLISH") bc++; if (tf[t] === "BEARISH") rc++; });

    let dom = "NONE", lvl = 0;
    if (bc >= ALIGNED_THRESHOLD) { dom = "BULLISH"; lvl = bc; }
    if (rc >= ALIGNED_THRESHOLD) { dom = "BEARISH"; lvl = rc; }
    s.alignmentCount = lvl;

    let mBO = "N/A", mSL = "N/A";
    if (dom !== "NONE") {
        const bos = [], sls = [];
        ZONE_TIMEFRAMES.forEach(t => {
            if (tf[t] === dom) {
                const b = s.breakouts[t], sl = s.stopLosses[t];
                if (b != null && b !== "N/A" && sl != null && sl !== "N/A") { bos.push(parseFloat(b)); sls.push(parseFloat(sl)); }
            }
        });
        if (bos.length && sls.length) {
            mBO = dom === "BULLISH" ? Math.max(...bos) : Math.min(...bos);
            mSL = dom === "BULLISH" ? Math.max(...sls) : Math.min(...sls);
        }
    }
    s.activeBO = mBO; s.activeSL = mSL;
    return { dominantState: dom, alignmentLevel: lvl, masterBO: mBO, masterSL: mSL };
}

function valGod(sym, dir) {
    if (!marketState[sym]) return { valid: false };
    const d = marketState[sym], g = d.lastAlertedState, ac = d.alignmentCount || 0;
    if (g === "NONE" || ac < GOD_MODE_THRESHOLD || dir !== g) return { valid: false };
    return { valid: true, godState: g, alignmentCount: ac };
}

function valAlign(sym, dir) {
    if (!marketState[sym]) return { valid: false };
    const d = marketState[sym], g = d.lastAlertedState, ac = d.alignmentCount || 0;
    if (g === "NONE" || ac < ALIGNED_THRESHOLD || dir !== g) return { valid: false };
    return { valid: true, godState: g, alignmentCount: ac };
}

function getATFs(sym, dir) {
    if (!marketState[sym]?.timeframes) return "N/A";
    return ZONE_TIMEFRAMES.filter(t => marketState[sym].timeframes[t] === dir).join(' + ') || "None";
}

// ── REDIS BOOT ──
const redisClient = createClient({ url: process.env.REDIS_URL });
redisClient.on('error', e => console.error('Redis:', e));
await redisClient.connect();
console.log('✅ Redis');

const savedState = await redisClient.get(REDIS_STATE_KEY);
if (savedState) {
    marketState = JSON.parse(savedState);
    for (const sym in marketState) {
        ["1D","4H","1W","1M"].forEach(t => {
            if (marketState[sym].timeframes) delete marketState[sym].timeframes[t];
            if (marketState[sym].breakouts) delete marketState[sym].breakouts[t];
            if (marketState[sym].stopLosses) delete marketState[sym].stopLosses[t];
        });
        if (!marketState[sym].timeframes) marketState[sym].timeframes = {};
        if (!marketState[sym].breakouts) marketState[sym].breakouts = {};
        if (!marketState[sym].stopLosses) marketState[sym].stopLosses = {};
        ZONE_TIMEFRAMES.forEach(t => {
            if (!marketState[sym].timeframes[t]) marketState[sym].timeframes[t] = "NONE";
            if (marketState[sym].breakouts[t] === undefined) marketState[sym].breakouts[t] = null;
            if (marketState[sym].stopLosses[t] === undefined) marketState[sym].stopLosses[t] = null;
        });
        const { dominantState } = recalcZones(sym);
        if (dominantState !== "NONE") {
            if (marketState[sym].lastAlertedState !== dominantState) {
                marketState[sym].lastAlertedState = dominantState;
                if (!marketState[sym].lastGodModeStartTime) marketState[sym].lastGodModeStartTime = Date.now();
            }
        } else { marketState[sym].lastAlertedState = "NONE"; marketState[sym].activeBO = "N/A"; marketState[sym].activeSL = "N/A"; }
    }
    await redisClient.set(REDIS_STATE_KEY, JSON.stringify(marketState));
}

const savedLog = await redisClient.get(REDIS_LOG_KEY);
if (savedLog) activityLog = JSON.parse(savedLog);
const savedTr = await redisClient.get(REDIS_TRADES_KEY);
if (savedTr) { tradeTracker = JSON.parse(savedTr); console.log('📊 Trades restored'); }

// ── API ──
app.get('/api/state', (_, res) => res.json({ marketState, activityLog, tradeTracker }));

app.get('/api/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    const id = Date.now();
    clients.push({ id, res });
    const ka = setInterval(() => res.write(': keepalive\n\n'), 15000);
    req.on('close', () => { clearInterval(ka); clients = clients.filter(c => c.id !== id); });
});

app.post('/api/delete', async (req, res) => {
    const { symbol, action } = req.body;
    if (!symbol || action !== 'DELETE') return res.status(400).send("Invalid");
    const sym = symbol.toUpperCase().trim();
    if (marketState[sym]) {
        delete marketState[sym];
        ENTRY_TIMEFRAMES.forEach(tf => { if (tradeTracker[tf]?.[sym]) delete tradeTracker[tf][sym]; });
        await redisClient.set(REDIS_STATE_KEY, JSON.stringify(marketState));
        await saveTracker();
        await pushLog(sym, 'NONE', '🗑️ Purged');
        broadcastAll();
        return res.status(200).send("OK");
    }
    return res.status(404).send("Not found");
});

app.post('/api/reset-trades', async (req, res) => {
    const { tf, symbol } = req.body;
    if (tf && symbol) {
        const s = symbol.toUpperCase().trim();
        if (tradeTracker[tf]?.[s]) tradeTracker[tf][s] = { signals:0,entered:0,tp:0,sl:0,pending:0,active:0,trades:[] };
    } else if (tf) { tradeTracker[tf] = {}; }
    else { tradeTracker = {}; }
    await saveTracker(); broadcastAll();
    return res.status(200).send("OK");
});

app.get('/api/channels', (_, res) => {
    const cfg = {};
    ENTRY_TIMEFRAMES.forEach(tf => {
        cfg[tf] = { godConfigured: !!TF_CHANNELS[tf]?.god, allConfigured: !!TF_CHANNELS[tf]?.all, label: TF_CHANNELS[tf]?.label || tf };
    });
    res.json({ channels: cfg, storylineConfigured: !!TELEGRAM_STORYLINE_CHAT_ID });
});

// ── WEBHOOK ──
app.post('/webhook', async (req, res) => {
    const p = req.body;
    const isStory = p.state !== undefined && p.tf !== undefined && !p.type;
    const isEntry = p.type !== undefined;

    // ── STORYLINE ──
    if (isStory) {
        const { symbol, tf, state, bo, sl } = p;
        if (!symbol || !tf || !state) return res.status(400).send("Invalid");
        if (!ZONE_TIMEFRAMES.includes(tf)) return res.status(200).send("OK");

        if (!marketState[symbol]) {
            marketState[symbol] = {
                timeframes: { "1H":"NONE","30M":"NONE","15M":"NONE" },
                breakouts: { "1H":null,"30M":null,"15M":null },
                stopLosses: { "1H":null,"30M":null,"15M":null },
                lastAlertedState:"NONE", activeBO:"N/A", activeSL:"N/A", alignmentCount:0, lastGodModeStartTime:null
            };
        }
        ["1D","4H","1W","1M"].forEach(o => {
            if (marketState[symbol].timeframes) delete marketState[symbol].timeframes[o];
            if (marketState[symbol].breakouts) delete marketState[symbol].breakouts[o];
            if (marketState[symbol].stopLosses) delete marketState[symbol].stopLosses[o];
        });
        marketState[symbol].timeframes[tf] = state;
        if (bo !== undefined) marketState[symbol].breakouts[tf] = bo;
        if (sl !== undefined) marketState[symbol].stopLosses[tf] = sl;

        const prev = marketState[symbol].lastAlertedState;
        const prevC = marketState[symbol].alignmentCount || 0;
        const { dominantState, alignmentLevel, masterBO, masterSL } = recalcZones(symbol);
        const lbl = n => n >= 3 ? "GOD MODE" : n >= 2 ? "ALIGNED" : "NONE";
        const aTFs = dir => ZONE_TIMEFRAMES.filter(t => marketState[symbol].timeframes[t] === dir).join(' + ');

        if (dominantState !== "NONE" && (dominantState !== prev || alignmentLevel !== prevC)) {
            const now = Date.now();
            if (prev === "NONE" || dominantState !== prev) marketState[symbol].lastGodModeStartTime = now;
            marketState[symbol].lastAlertedState = dominantState;
            const tfs = aTFs(dominantState);
            if (alignmentLevel >= 3) {
                const e = dominantState === "BULLISH" ? "🚀 🐂" : "🩸 🐻";
                await sendStoryline(`<b>${e} GOD-MODE: ${symbol}</b>\n\n<b>Trend:</b> ${dominantState} (${alignmentLevel}/3)\n<b>Zone:</b> <code>${masterBO}</code> → <code>${masterSL}</code>\n<b>Aligned:</b> ${tfs} ✅\n<b>Status:</b> ⚡ GOD MODE`);
                await pushLog(symbol, dominantState, `⚡ GOD MODE | ${tfs}`, now);
            } else {
                const e = dominantState === "BULLISH" ? "📈 🐂" : "📉 🐻";
                await sendStoryline(`<b>${e} ALIGNED: ${symbol}</b>\n\n<b>Trend:</b> ${dominantState} (${alignmentLevel}/3)\n<b>Zone:</b> <code>${masterBO}</code> → <code>${masterSL}</code>\n<b>Aligned:</b> ${tfs} ✅\n<b>Status:</b> 🔶 ALIGNED`);
                await pushLog(symbol, dominantState, `🔶 Aligned | ${tfs}`, now);
            }
        } else if (dominantState !== "NONE" && dominantState === prev && alignmentLevel < prevC && alignmentLevel >= 2) {
            await sendStoryline(`<b>⚠️ DOWNGRADED: ${symbol}</b>\n\n${lbl(prevC)} → ${lbl(alignmentLevel)}`);
            await pushLog(symbol, dominantState, `⚠️ ${lbl(prevC)} → ${lbl(alignmentLevel)}`);
        } else if (dominantState === "NONE" && prev !== "NONE") {
            marketState[symbol].lastAlertedState = "NONE"; marketState[symbol].activeBO = "N/A"; marketState[symbol].activeSL = "N/A"; marketState[symbol].alignmentCount = 0;
            await sendStoryline(`<b>⚠️ TREND LOST: ${symbol}</b>\n\nWas: ${prev} | Below 2/3`);
            await pushLog(symbol, 'NONE', `Lost: ${prev}`);
        }
        await redisClient.set(REDIS_STATE_KEY, JSON.stringify(marketState));
        broadcastAll();
        return res.status(200).send("OK");
    }

    // ── ENTRY: SIGNAL / ENTRY_FILLED / TP_HIT / SL_HIT ──
    if (isEntry) {
        const { symbol, type, direction, entry, sl, tp, rr, tf, touched_level, action } = p;
        if (!symbol || !type || !direction || entry === undefined || sl === undefined) return res.status(400).send("Invalid");

        const entryTF = tf ? tf.toUpperCase() : null;
        const tfCfg = entryTF ? TF_CHANNELS[entryTF] : null;
        if (!entryTF || !tfCfg) return res.status(400).send(`Bad TF: ${tf}`);

        const act = (action || "SIGNAL").toUpperCase();
        const tracker = getTracker(entryTF, symbol);
        const rrVal = rr || 5;
        const tpVal = tp || (direction === "BULLISH"
            ? parseFloat(entry) + Math.abs(parseFloat(entry) - parseFloat(sl)) * rrVal
            : parseFloat(entry) - Math.abs(parseFloat(entry) - parseFloat(sl)) * rrVal);

        console.log(`[${act} ${entryTF}] ${symbol} | ${type} | ${direction} | E:${entry} SL:${sl} TP:${tpVal}`);

        if (act === "SIGNAL") {
            // New signal → PENDING trade
            tracker.trades.push({
                entry: parseFloat(entry), sl: parseFloat(sl), tp: parseFloat(tpVal),
                rr: rrVal, direction, type, touched_level: touched_level || "N/A",
                status: "PENDING", timestamp: Date.now()
            });
            if (tracker.trades.length > 100) tracker.trades = tracker.trades.slice(-100);
            recalcCounts(tracker);

            // Telegram: SIGNAL only
            const emoji = direction === "BULLISH" ? "🟢 🐂" : "🔴 🐻";
            const alignedTFs = getATFs(symbol, direction);

            const gv = valGod(symbol, direction);
            if (gv.valid) {
                let msg = `<b>${emoji} ⚡ GOD SIGNAL [${entryTF}]: ${symbol}</b>\n\n`;
                msg += `<b>Type:</b> ${type}\n<b>Entry:</b> <code>${entry}</code>\n<b>SL:</b> <code>${sl}</code>\n<b>TP (${rrVal}R):</b> <code>${tpVal}</code>\n`;
                msg += `<b>Level:</b> ${touched_level || "N/A"}\n\n<b>Storyline:</b> ✅ ${gv.godState} (${gv.alignmentCount}/3)\n<b>Aligned:</b> ${alignedTFs}\n<b>Status:</b> ⚡ GOD MODE`;
                await sendGodEntry(entryTF, msg);
            }
            const av = valAlign(symbol, direction);
            if (av.valid) {
                const tag = av.alignmentCount >= 3 ? "⚡ GOD MODE" : "🔶 ALIGNED";
                let msg = `<b>${emoji} ALIGNED SIGNAL [${entryTF}]: ${symbol}</b>\n\n`;
                msg += `<b>Type:</b> ${type}\n<b>Entry:</b> <code>${entry}</code>\n<b>SL:</b> <code>${sl}</code>\n<b>TP (${rrVal}R):</b> <code>${tpVal}</code>\n`;
                msg += `<b>Level:</b> ${touched_level || "N/A"}\n\n<b>Storyline:</b> ✅ ${av.godState} (${av.alignmentCount}/3)\n<b>Aligned:</b> ${alignedTFs}\n<b>Status:</b> ${tag}`;
                await sendAlignEntry(entryTF, msg);
            }

        } else if (act === "ENTRY_FILLED") {
            // Entry filled → find PENDING trade, mark ACTIVE
            const trade = tracker.trades.find(t =>
                t.status === "PENDING" &&
                Math.abs(t.entry - parseFloat(entry)) < 0.0001 &&
                t.direction === direction
            );
            if (trade) trade.status = "ACTIVE";
            recalcCounts(tracker);
            console.log(`📥 [FILLED] ${symbol} ${entryTF}`);

        } else if (act === "TP_HIT") {
            // TP → find ACTIVE or PENDING (same-candle entry+TP)
            const trade = tracker.trades.find(t =>
                (t.status === "ACTIVE" || t.status === "PENDING") &&
                Math.abs(t.entry - parseFloat(entry)) < 0.0001 &&
                t.direction === direction
            );
            if (trade) trade.status = "TP_HIT";
            recalcCounts(tracker);
            console.log(`✅ [TP] ${symbol} ${entryTF}`);

        } else if (act === "SL_HIT") {
            // SL → find ACTIVE or PENDING (same-candle entry+SL)
            const trade = tracker.trades.find(t =>
                (t.status === "ACTIVE" || t.status === "PENDING") &&
                Math.abs(t.entry - parseFloat(entry)) < 0.0001 &&
                t.direction === direction
            );
            if (trade) trade.status = "SL_HIT";
            recalcCounts(tracker);
            console.log(`❌ [SL] ${symbol} ${entryTF}`);
        }

        await saveTracker();
        broadcastAll();
        return res.status(200).send("OK");
    }

    return res.status(400).send("Unknown");
});

app.listen(PORT, () => {
    console.log(`\n🚀 God-Mode V3.5 on port ${PORT}`);
    console.log(`📐 Storyline: ${ZONE_TIMEFRAMES.join('+')} | Entry: ${ENTRY_TIMEFRAMES.join('+')}`);
    console.log(`📊 God: ${GOD_MODE_THRESHOLD}/3 | Aligned: ${ALIGNED_THRESHOLD}/3`);
    console.log(`📡 SIGNAL → Telegram | ENTRY/TP/SL → Stats only`);
});
