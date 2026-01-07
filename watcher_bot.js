require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const mongoose = require('mongoose');
const express = require('express');
const { request, gql } = require('graphql-request');

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

// --- SERVER KEEPALIVE (For UptimeRobot) ---
const app = express();
app.get('/', (req, res) => res.send('Watcher Bot: Wolf Pack Edition Online 🟢'));
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
            // Buy Volume must be 3x Sell Volume (unless Sells are 0)
            const ratio = sellVol === 0 ? buyVol : (buyVol / sellVol);
            if (sellVol > 0 && ratio < 3.0) continue;

            // 3. Unique Wallets Check
            const uniqueBuyers = new Set(data.buys.map(t => t.user)).size;

            let alertType = null;

            // --- CONDITION A: WOLF PACK (3+ Strangers, >$10k) ---
            if (uniqueBuyers >= 3 && buyVol > 10000) {
                alertType = "WOLF_PACK";
            }
            // --- CONDITION B: VOLUME SURGE (Any Count, >$15k) ---
            else if (buyVol > 15000) {
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
                    marketId: marketId // Used for link
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
async function scanSpecificWallets(chatId) {
    const user = await User.findOne({ chatId });
    if (!user || !user.wallets.length) return;

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
                    }
                    // Update DB with new hash
                    await User.updateOne(
                        { chatId, "wallets.address": w.address },
                        { $set: { "wallets.$.lastHash": currentHash } }
                    );
                } else if (!w.lastHash) {
                    // Initial Sync
                    await User.updateOne(
                        { chatId, "wallets.address": w.address },
                        { $set: { "wallets.$.lastHash": currentHash } }
                    );
                }
            }
        } catch (e) { console.error(`Error scanning wallet ${w.name}`); }
    }
}

// ============================================================
// 🐺 FEATURE 2 & 3: GLOBAL HUNTER (The Wolf Pack)
// ============================================================
async function scanGlobalMarket() {
    // Queries The Graph for the last 50 Buy transactions
    const query = gql`
    {
      transactions(first: 50, orderBy: timestamp, orderDirection: desc, where: {type: "Buy"}) {
        id
        timestamp
        market { id question slug }
        user { id }
        tradeAmount
        outcomeIndex
      }
    }
    `;

    try {
        // Use the standard Polymarket Subgraph
        const data = await request('https://api.thegraph.com/subgraphs/name/tokenunion/polymarket-matic', query);
        
        // Feed the Brain
        data.transactions.forEach(t => {
            detector.addTrade({
                timestamp: t.timestamp * 1000, // Convert to ms
                amountUSD: parseFloat(t.tradeAmount) / 1000000, // Graph stores in USDC wei (6 decimals)
                user: t.user.id,
                marketId: t.market.id, // Unique ID for deduplication
                marketName: t.market.question,
                marketSlug: t.market.slug,
                outcome: t.outcomeIndex === 0 ? "NO" : "YES", 
                side: "Buy"
            });
        });

        // Ask the Brain for signals
        const signals = detector.checkSignals();

        if (signals.length > 0) {
            // Broadcast to ALL users
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
           `<a href="https://polymarket.com/market/${alert.marketId}">View Market</a>`;
}

// ============================================================
// 🤖 BOT COMMANDS
// ============================================================
bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, 
        "👋 **Watcher Online**\n\n" +
        "1. **Sentinel:** Tracking your watchlist.\n" +
        "2. **Wolf Pack:** Scanning global activity for clusters.\n" +
        "3. **Surge:** Watching for massive buys.", 
        { parse_mode: "Markdown", reply_markup: { keyboard: [["➕ Add Wallet", "📋 View Watchlist"]], resize_keyboard: true } }
    );
});

bot.on('message', async (msg) => {
    const chatId = msg.chat.id.toString();
    const text = msg.text;
    if (text.startsWith('/')) return;

    if (!userState[chatId]) userState[chatId] = { step: null };

    // Add Wallet Logic
    if (text === "➕ Add Wallet") {
        userState[chatId].step = 'WAITING_FOR_ADDRESS';
        bot.sendMessage(chatId, "Paste Address:");
        return;
    }
    if (userState[chatId].step === 'WAITING_FOR_ADDRESS') {
        userState[chatId].tempAddress = text.trim();
        userState[chatId].step = 'WAITING_FOR_NAME';
        bot.sendMessage(chatId, "Name this wallet:");
        return;
    }
    if (userState[chatId].step === 'WAITING_FOR_NAME') {
        let user = await User.findOne({ chatId });
        if (!user) user = new User({ chatId, wallets: [] });
        
        if (user.wallets.length >= 5) {
            bot.sendMessage(chatId, "Limit Reached (5).");
        } else {
            user.wallets.push({ address: userState[chatId].tempAddress, name: text, lastHash: null });
            await user.save();
            bot.sendMessage(chatId, `✅ Added ${text}`);
        }
        userState[chatId] = { step: null };
    }

    // View Watchlist Logic
    if (text === "📋 View Watchlist") {
        const user = await User.findOne({ chatId });
        if (!user || !user.wallets.length) return bot.sendMessage(chatId, "Empty.");
        const buttons = user.wallets.map(w => [{ text: `🗑 ${w.name}`, callback_data: `DEL_${w.address}` }]);
        bot.sendMessage(chatId, "Your Watchlist:", { reply_markup: { inline_keyboard: buttons } });
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

// Loop 1: Check Private Wallets (Every 15s)
setInterval(async () => {
    const users = await User.find({});
    for (const user of users) {
        await scanSpecificWallets(user.chatId);
    }
}, USER_SCAN_INTERVAL);

// Loop 2: Check Global Market (Every 15s)
setInterval(async () => {
    await scanGlobalMarket();
}, GLOBAL_SCAN_INTERVAL);

console.log("🔥 Watcher Bot v2: Wolf Pack Edition Running...");