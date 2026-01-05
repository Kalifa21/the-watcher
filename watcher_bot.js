require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const express = require('express');
const mongoose = require('mongoose'); // NEW: Database Tool

// --- CONFIGURATION ---
const TOKEN = process.env.TELEGRAM_TOKEN;
const MONGO_URI = process.env.MONGO_URI; // NEW: Database Password
const CHECK_INTERVAL = 15000;
const MAX_WALLETS = 5;

// Safety Checks
if (!TOKEN) { console.error("❌ ERROR: Missing TELEGRAM_TOKEN"); process.exit(1); }
if (!MONGO_URI) { console.error("❌ ERROR: Missing MONGO_URI"); process.exit(1); }

// --- MONGODB SETUP (The Persistent Brain) ---
mongoose.connect(MONGO_URI)
    .then(() => console.log("✅ Connected to MongoDB"))
    .catch(err => console.error("❌ MongoDB Error:", err));

// Define the "Shape" of our data
const userSchema = new mongoose.Schema({
    chatId: { type: String, required: true, unique: true },
    wallets: [{
        address: String,
        name: String,
        lastHash: String
    }]
});
const User = mongoose.model('User', userSchema);
// ---------------------------------------------

// --- CLOUD SERVER SETUP ---
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Watcher Bot is Alive & Connected to DB!'));
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

const bot = new TelegramBot(TOKEN, { polling: true });
const userState = {};

// --- NEW DATABASE FUNCTIONS (Async) ---

async function getWallets(chatId) {
    const user = await User.findOne({ chatId });
    return user ? user.wallets : [];
}

async function addWallet(chatId, address, name) {
    const cleanAddress = address.trim().toLowerCase();
    
    // Find user or create new one
    let user = await User.findOne({ chatId });
    if (!user) {
        user = new User({ chatId, wallets: [] });
    }

    // Checks
    if (user.wallets.length >= MAX_WALLETS) return "LIMIT_REACHED";
    if (user.wallets.find(w => w.address === cleanAddress)) return "DUPLICATE";

    // Add
    user.wallets.push({ address: cleanAddress, name, lastHash: null });
    await user.save(); // Save to Cloud
    return "SUCCESS";
}

async function removeWallet(chatId, address) {
    const user = await User.findOne({ chatId });
    if (user) {
        user.wallets = user.wallets.filter(w => w.address !== address);
        await user.save();
    }
}

async function updateWalletHash(chatId, address, newHash) {
    await User.updateOne(
        { chatId, "wallets.address": address },
        { $set: { "wallets.$.lastHash": newHash } }
    );
}

// --- BOT INTERFACE ---
bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, 
        "👋 **Welcome to The Watcher** 👁️\n\n" +
        "I am your private spy for Polymarket whales. 🐋\n" +
        "Your data is now **securely saved in the cloud.** ☁️\n\n" +
        "_Stay Alpha._ 🚀", 
        {
            parse_mode: "Markdown",
            reply_markup: {
                keyboard: [["➕ Add Wallet", "📋 View Watchlist"], ["🚀 Scan My List", "❓ Help"]],
                resize_keyboard: true,
                is_persistent: true
            }
        }
    );
});

bot.on('message', async (msg) => {
    const chatId = msg.chat.id.toString(); // Ensure ID is string
    const text = msg.text;
    if (text.startsWith('/')) return;
    if (!userState[chatId]) userState[chatId] = { step: null };

    // --- ADD WALLET ---
    if (text === "➕ Add Wallet") {
        const wallets = await getWallets(chatId);
        if (wallets.length >= MAX_WALLETS) {
            bot.sendMessage(chatId, `⚠️ Limit Reached (${MAX_WALLETS} Max).`, { parse_mode: "Markdown" });
            return;
        }
        userState[chatId].step = 'WAITING_FOR_ADDRESS';
        bot.sendMessage(chatId, "🕵️ **Paste the Polymarket Address:**", { parse_mode: "Markdown" });
        return;
    }

    if (userState[chatId].step === 'WAITING_FOR_ADDRESS') {
        userState[chatId].tempAddress = text.trim();
        userState[chatId].step = 'WAITING_FOR_NAME';
        bot.sendMessage(chatId, "🏷️ **Give this whale a name:**");
        return;
    }

    if (userState[chatId].step === 'WAITING_FOR_NAME') {
        const result = await addWallet(chatId, userState[chatId].tempAddress, text);
        
        if (result === "SUCCESS") bot.sendMessage(chatId, `✅ **Added!**\nNow tracking: **${text}**`, { parse_mode: "Markdown" });
        else if (result === "LIMIT_REACHED") bot.sendMessage(chatId, "⚠️ Limit reached.");
        else if (result === "DUPLICATE") bot.sendMessage(chatId, "⚠️ Already tracking this.");
        
        userState[chatId] = { step: null };
        return;
    }

    // --- VIEW WATCHLIST ---
    if (text === "📋 View Watchlist") {
        const wallets = await getWallets(chatId);
        if (wallets.length === 0) return bot.sendMessage(chatId, "📭 Watchlist empty.");
        
        const buttons = wallets.map(w => [{ text: `🗑 Remove ${w.name}`, callback_data: `DEL_${w.address}` }]);
        bot.sendMessage(chatId, `📋 **Your Watchlist (${wallets.length}/${MAX_WALLETS}):**`, { reply_markup: { inline_keyboard: buttons } });
    }

    if (text === "🚀 Scan My List") {
        bot.sendMessage(chatId, "🔎 Scanning...");
        await scanUser(chatId, true);
    }
    
    if (text === "❓ Help") {
        bot.sendMessage(chatId, "ℹ️ **Info:**\n• Track up to 5 wallets.\n• Data saved in MongoDB.\n• Alerts are instant.");
    }
});

bot.on('callback_query', async (q) => {
    if (q.data.startsWith('DEL_')) {
        await removeWallet(q.message.chat.id.toString(), q.data.replace('DEL_', ''));
        bot.answerCallbackQuery(q.id, { text: "Deleted" });
        bot.deleteMessage(q.message.chat.id, q.message.message_id);
    }
});

// --- TRACKER LOGIC ---
async function scanUser(chatId, isManual = false) {
    const wallets = await getWallets(chatId);
    if (!wallets || wallets.length === 0) {
        if (isManual) bot.sendMessage(chatId, "📭 No wallets.");
        return;
    }

    let updatesFound = false;

    for (const w of wallets) {
        try {
            const res = await axios.get(`https://data-api.polymarket.com/activity`, {
                params: { user: w.address, limit: 1, sortBy: 'TIMESTAMP', sortDirection: 'DESC' }
            });

            if (res.data.length > 0) {
                const trade = res.data[0];
                const currentHash = trade.id || trade.transactionHash; 

                if (w.lastHash && w.lastHash !== currentHash) {
                    if (trade.type === "TRADE") {
                        const side = trade.side; 
                        let assetName = trade.outcome || trade.asset || "Position";
                        if (/^\d+$/.test(assetName)) assetName = "Position"; 

                        const title = trade.title || "Unknown Market";
                        const amount = parseFloat((trade.size || 0) * (trade.price || 0)).toFixed(2);
                        const link = `https://polymarket.com/market/${trade.slug}`;
                        const action = side === "BUY" ? "Buys" : "Sells";
                        const emoji = side === "BUY" ? "🟢" : "🔴";

                        const msg = `${emoji} **${w.name} Alert**\n\n` +
                                    `**${action} ${assetName}** in _${title}_\n` +
                                    `💰 Value: $${amount}\n` +
                                    `🔗 [View Market](${link})`;

                        bot.sendMessage(chatId, msg, { parse_mode: "Markdown", disable_web_page_preview: true });
                        updatesFound = true;
                    }
                    // Update Hash in Cloud DB
                    await updateWalletHash(chatId, w.address, currentHash);
                } else if (!w.lastHash) {
                     // Initial Sync
                     await updateWalletHash(chatId, w.address, currentHash);
                }
            }
        } catch (e) {
            console.error(`Error checking ${w.name}:`, e.message);
        }
    }

    if (isManual && !updatesFound) bot.sendMessage(chatId, "✅ No new trades.");
}

// --- GLOBAL AUTO-SCANNER ---
setInterval(async () => {
    // Find all users in DB
    const users = await User.find({});
    if (users.length > 0) {
        process.stdout.write("."); 
        for (const user of users) {
            await scanUser(user.chatId, false);
        }
    }
}, CHECK_INTERVAL);

console.log("MongoDB Watcher Running...");