require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const mongoose = require('mongoose');
const express = require('express');

// --- CONFIGURATION ---
const TOKEN = process.env.TELEGRAM_TOKEN;
const MONGO_URI = process.env.MONGO_URI;
const PORT = process.env.PORT || 3000;

// Intervals
const USER_SCAN_INTERVAL = 15000;   // Feature 1: Check your watchlist every 15s
const GLOBAL_SCAN_INTERVAL = 15000; // Feature 2/3: Check global market every 15s

// --- DATABASE SETUP ---
mongoose.connect(MONGO_URI)
    .then(() => console.log("✅ Connected to MongoDB"))
    .catch(err => console.error("❌ MongoDB Error:", err));

const userSchema = new mongoose.Schema({
    chatId: { type: String, required: true, unique: true },
    wallets: [{ address: String, name: String, lastHash: String }]
});
const User = mongoose.model('User', userSchema);

// --- SERVER KEEPALIVE ---
const app = express();
app.get('/', (req, res) => res.send('The Watcher: Online 🟢'));
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

const bot = new TelegramBot(TOKEN, { polling: true });
const userState = {};

// ============================================================
// 🧠 THE BRAIN: MarketDetector Class (Wolf Pack Logic)
// ============================================================
class MarketDetector {
    constructor() {
        this.tradeWindow = []; // Stores recent global trades
        this.alertCooldowns = {}; // Prevents spam
    }

    addTrade(trade) {
        this.tradeWindow.push(trade);
        // Prune trades older than 60 seconds (The sliding window)
        const cutoff = Date.now() - 60000;
        this.tradeWindow = this.tradeWindow.filter(t => t.timestamp > cutoff);
    }

    checkSignals() {
        const now = Date.now();
        const signals = [];
        
        // Group trades by Market/Token
        const groups = {};
        this.tradeWindow.forEach(t => {
            if (!groups[t.marketId]) {
                groups[t.marketId] = { buys: [], sells: [], meta: t };
            }
            if (t.side === 'Buy') groups[t.marketId].buys.push(t);
            else groups[t.marketId].sells.push(t);
        });

        // Analyze each Market
        for (const [marketId, data] of Object.entries(groups)) {
            // 1. Cooldown Check (Don't alert same market twice in 5 mins)
            if (this.alertCooldowns[marketId] && (now - this.alertCooldowns[marketId] < 300000)) continue;

            const buyVol = data.buys.reduce((sum, t) => sum + t.amountUSD, 0);
            const sellVol = data.sells.reduce((sum, t) => sum + t.amountUSD, 0);
            
            // 2. Ratio Check (Noise Filter)
            const ratio = sellVol === 0 ? buyVol : (buyVol / sellVol);
            if (sellVol > 0 && ratio < 3.0) continue;

            // 3. Unique Wallets Check
            const uniqueBuyers = new Set(data.buys.map(t => t.user)).size;

            let alertType = null;

            // --- CONDITION A: WOLF PACK (LOWERED LIMIT) ---
            // 3+ Strangers, Volume > $100 (Was $10k)
            if (uniqueBuyers >= 3 && buyVol > 100) {
                alertType = "WOLF_PACK";
            }
            // --- CONDITION B: VOLUME SURGE (LOWERED LIMIT) ---
            // Any Count, Volume > $150 (Was $15k)
            else if (buyVol > 150) {
                alertType = "VOLUME_SURGE";
            }

            if (alertType) {
                this.alertCooldowns[marketId] = now;
                signals.push({
                    type: alertType,
                    marketName: data.meta.marketName,
                    outcome: data.meta.outcome,
                    totalVol: buyVol,
                    uniqueWallets: uniqueBuyers,
                    ratio: ratio,
                    marketId: marketId,
                    marketSlug: data.meta.marketSlug
                });
            }
        }
        return signals;
    }
}

const detector = new MarketDetector();

// ============================================================
// 🕵️ FEATURE 1: PRIVATE WATCHLIST TRACKER (The Sentinel)
// ============================================================
async function scanSpecificWallets(chatId, isManual = false) {
    const user = await User.findOne({ chatId });
    if (!user || !user.wallets.length) {
        if (isManual) bot.sendMessage(chatId, "📭 Your watchlist is empty.");
        return;
    }

    let updatesFound = false;

    for (const w of user.wallets) {
        try {
            const res = await axios.get(`https://data-api.polymarket.com/activity`, {
                params: { user: w.address, limit: 1, sortBy: 'TIMESTAMP', sortDirection: 'DESC' }
            });

            if (res.data.length > 0) {
                const trade = res.data[0];
                const currentHash = trade.id || trade.transactionHash; 

                if (w.lastHash && w.lastHash !== currentHash) {
                    if (trade.type === "TRADE") {
                        const amount = parseFloat((trade.size || 0) * (trade.price || 0)).toFixed(2);
                        const msg = `🔔 <b>${w.name} Alert</b>\n` +
                                    `Action: ${trade.side === "BUY" ? "🟢 Buy" : "🔴 Sell"}\n` +
                                    `Asset: ${trade.outcome || "Position"}\n` +
                                    `Market: ${trade.title}\n` +
                                    `Value: $${amount}\n` +
                                    `<a href="https://polymarket.com/market/${trade.slug}">View Market</a>`;
                        
                        bot.sendMessage(chatId, msg, { parse_mode: "HTML", disable_web_page_preview: true });
                        updatesFound = true;
                    }
                    await User.updateOne(
                        { chatId, "wallets.address": w.address },
                        { $set: { "wallets.$.lastHash": currentHash } }
                    );
                } else if (!w.lastHash) {
                    await User.updateOne(
                        { chatId, "wallets.address": w.address },
                        { $set: { "wallets.$.lastHash": currentHash } }
                    );
                }
            }
        } catch (e) { console.error(`Error scanning wallet ${w.name}`); }
    }

    if (isManual && !updatesFound) {
        bot.sendMessage(chatId, "✅ No new trades found.");
    }
}

// ============================================================
// 🐺 FEATURE 2 & 3: GLOBAL HUNTER (Official Gamma API)
// ============================================================
async function scanGlobalMarket() {
    try {
        // 1. Get Top 20 Trending Markets
        const { data: markets } = await axios.get('https://gamma-api.polymarket.com/markets', {
            params: {
                limit: 20,
                active: true,
                closed: false,
                order: 'volume24hr',
                ascending: false
            }
        });

        // 2. Scan each Hot Market
        const scanPromises = markets.map(async (market) => {
            try {
                // Fetch last 5 trades
                const { data: trades } = await axios.get(`https://data-api.polymarket.com/activity`, {
                    params: {
                        limit: 5,
                        slug: market.slug,
                        type: 'TRADE'
                    }
                });

                // Feed the Brain
                trades.forEach(t => {
                    if (t.side === 'BUY') {
                        detector.addTrade({
                            timestamp: new Date(t.timestamp).getTime(),
                            amountUSD: parseFloat(t.size) * parseFloat(t.price),
                            user: t.taker || t.proxyWallet || "Unknown", 
                            marketId: market.id,
                            marketName: market.question,
                            marketSlug: market.slug,
                            outcome: t.outcome || "Yes/No",
                            side: "Buy"
                        });
                    }
                });
            } catch (err) { }
        });

        await Promise.all(scanPromises);

        // 3. Check for signals
        const signals = detector.checkSignals();

        if (signals.length > 0) {
            const users = await User.find({});
            for (const sig of signals) {
                const html = formatAlert(sig);
                for (const u of users) {
                    bot.sendMessage(u.chatId, html, { parse_mode: "HTML", disable_web_page_preview: true });
                }
            }
        }

    } catch (e) {
        console.error("Global Scan Error:", e.message);
    }
}

function formatAlert(alert) {
    let title = "⚠️ <b>Market Alert</b>";
    if (alert.type === "WOLF_PACK") title = "🚨 <b>Wolf Pack Cluster Detected</b>";
    if (alert.type === "VOLUME_SURGE") title = "🌊 <b>High Volume Surge Detected</b>";

    const volStr = alert.totalVol.toLocaleString('en-US', { maximumFractionDigits: 0 });
    const ratioStr = alert.ratio > 100 ? "MAX" : alert.ratio.toFixed(1);

    return `${title}\n\n` +
           `🎯 <b>Market:</b> ${alert.marketName}\n` +
           `📈 <b>Outcome:</b> ${alert.outcome}\n` +
           `💰 <b>Total Vol:</b> $${volStr}\n` +
           `👥 <b>Unique Wallets:</b> ${alert.uniqueWallets}\n` +
           `⚖️ <b>Buy Pressure:</b> ${ratioStr}x\n` +
           `⏱ <b>Time Window:</b> 60s\n\n` +
           `<a href="https://polymarket.com/market/${alert.marketSlug}">View Market</a>`;
}

// ============================================================
// 🤖 BOT INTERFACE
// ============================================================
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    let user = await User.findOne({ chatId });
    const walletCount = user ? user.wallets.length : 0;

    const welcomeMsg = 
        "👁️ **The Watcher is Online.**\n\n" +
        "I am your private surveillance tool for Polymarket.\n\n" +
        "**Active Systems:**\n" +
        "🟢 **Sentinel:** Tracking your watchlist.\n" +
        "🐺 **Wolf Pack:** Scanning 20+ markets for clusters.\n" +
        "🌊 **Surge:** Detecting whale momentum.\n\n" +
        "_Select an option below:_";

    const opts = {
        parse_mode: "Markdown",
        reply_markup: {
            keyboard: [
                ["➕ Add Wallet", `📋 View Watchlist (${walletCount}/5)`],
                ["🚀 Scan My List", "❓ Help"]
            ],
            resize_keyboard: true,
            is_persistent: true
        }
    };
    bot.sendMessage(chatId, welcomeMsg, opts);
});

bot.on('message', async (msg) => {
    const chatId = msg.chat.id.toString();
    const text = msg.text;
    if (text.startsWith('/')) return;

    if (!userState[chatId]) userState[chatId] = { step: null };

    // --- ADD WALLET ---
    if (text === "➕ Add Wallet") {
        userState[chatId].step = 'WAITING_FOR_ADDRESS';
        bot.sendMessage(chatId, "🕵️ **Paste the Polymarket Address:**", {parse_mode: "Markdown"});
        return;
    }
    if (userState[chatId].step === 'WAITING_FOR_ADDRESS') {
        userState[chatId].tempAddress = text.trim();
        userState[chatId].step = 'WAITING_FOR_NAME';
        bot.sendMessage(chatId, "🏷️ **Give this whale a name:**", {parse_mode: "Markdown"});
        return;
    }
    if (userState[chatId].step === 'WAITING_FOR_NAME') {
        let user = await User.findOne({ chatId });
        if (!user) user = new User({ chatId, wallets: [] });
        
        if (user.wallets.length >= 5) {
            bot.sendMessage(chatId, "⚠️ Limit Reached (Max 5 Wallets).");
        } else {
            user.wallets.push({ address: userState[chatId].tempAddress, name: text, lastHash: null });
            await user.save();
            bot.sendMessage(chatId, `✅ **Added!**\nNow tracking: **${text}**`, {parse_mode: "Markdown"});
        }
        userState[chatId] = { step: null };
        return;
    }

    // --- VIEW WATCHLIST ---
    if (text.startsWith("📋 View Watchlist")) {
        const user = await User.findOne({ chatId });
        if (!user || !user.wallets.length) return bot.sendMessage(chatId, "📭 Your watchlist is empty.");
        const buttons = user.wallets.map(w => [{ text: `🗑 Remove ${w.name}`, callback_data: `DEL_${w.address}` }]);
        bot.sendMessage(chatId, `📋 **Your Watchlist (${user.wallets.length}/5):**`, { reply_markup: { inline_keyboard: buttons }, parse_mode: "Markdown" });
    }

    // --- SCAN MY LIST ---
    if (text === "🚀 Scan My List") {
        bot.sendMessage(chatId, "🔎 Scanning your targets...");
        await scanSpecificWallets(chatId, true);
    }

    // --- HELP ---
    if (text === "❓ Help") {
        const helpMsg = 
            "ℹ️ **How to use The Watcher:**\n\n" +
            "1️⃣ **Sentinel (Private Spy):**\n" +
            "Add up to 5 wallets. You get an alert whenever they trade.\n\n" +
            "2️⃣ **Wolf Pack (Global Radar):**\n" +
            "I automatically scan the Top 20 trending markets. If 3+ strangers buy together (>$100), you get an alert.\n\n" +
            "3️⃣ **Volume Surge:**\n" +
            "Alerts if ANYONE buys >$150 in a single clip.";
        
        bot.sendMessage(chatId, helpMsg, { parse_mode: "Markdown" });
    }
});

bot.on('callback_query', async (q) => {
    if (q.data.startsWith('DEL_')) {
        await User.updateOne({ chatId: q.message.chat.id }, { $pull: { wallets: { address: q.data.replace('DEL_', '') } } });
        bot.answerCallbackQuery(q.id, { text: "Deleted" });
        bot.deleteMessage(q.message.chat.id, q.message.message_id);
    }
});

// ============================================================
// 🔄 LOOPS
// ============================================================

// Loop 1: Sentinel (Every 15s)
setInterval(async () => {
    const users = await User.find({});
    for (const user of users) {
        await scanSpecificWallets(user.chatId, false);
    }
}, USER_SCAN_INTERVAL);

// Loop 2: Wolf Pack (Every 15s)
setInterval(async () => {
    await scanGlobalMarket();
}, GLOBAL_SCAN_INTERVAL);

console.log("🔥 The Watcher v3: Online...");