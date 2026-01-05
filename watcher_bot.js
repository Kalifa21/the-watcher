require('dotenv').config(); // Load hidden variables
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const express = require('express');

// --- SECURE CONFIGURATION ---
// The bot now looks for the token in the environment variables
const TOKEN = process.env.TELEGRAM_TOKEN; 

// Safety Check: Stop if no token is found
if (!TOKEN) {
    console.error("❌ ERROR: No Token found! Make sure you have a .env file locally or set the Environment Variable on Render.");
    process.exit(1);
}

const DB_FILE = path.join(__dirname, 'user_database.json');
const CHECK_INTERVAL = 15000; // Check every 15 seconds
const MAX_WALLETS = 5; 

// --- CLOUD SERVER SETUP (Keep-Alive) ---
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.send('Watcher Bot is Alive!');
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
// ---------------------------------------

const bot = new TelegramBot(TOKEN, { polling: true });
const userState = {};

// --- DATABASE FUNCTIONS ---
function loadDB() {
    if (!fs.existsSync(DB_FILE)) return {};
    try { return JSON.parse(fs.readFileSync(DB_FILE)); } catch (e) { return {}; }
}

function saveDB(data) {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

function addWallet(chatId, address, name) {
    const db = loadDB();
    const userWallets = db[chatId] || [];
    
    if (userWallets.length >= MAX_WALLETS) return "LIMIT_REACHED";
    const cleanAddress = address.trim().toLowerCase();
    if (userWallets.find(w => w.address === cleanAddress)) return "DUPLICATE";

    userWallets.push({ address: cleanAddress, name, lastHash: null });
    db[chatId] = userWallets;
    saveDB(db);
    return "SUCCESS";
}

function removeWallet(chatId, address) {
    const db = loadDB();
    if (!db[chatId]) return;
    db[chatId] = db[chatId].filter(w => w.address !== address);
    saveDB(db);
}

// --- BOT INTERFACE ---
bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, 
        "👋 **Welcome to The Watcher** 👁️\n\n" +
        "I am your private spy for Polymarket whales. 🐋\n" +
        "Add up to **5 Wallets** and get instant alerts on their trades.\n\n" +
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
    const chatId = msg.chat.id;
    const text = msg.text;
    if (text.startsWith('/')) return;
    if (!userState[chatId]) userState[chatId] = { step: null };

    // --- ADD WALLET ---
    if (text === "➕ Add Wallet") {
        const db = loadDB();
        const count = (db[chatId] || []).length;
        if (count >= MAX_WALLETS) {
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
        const result = addWallet(chatId, userState[chatId].tempAddress, text);
        if (result === "SUCCESS") bot.sendMessage(chatId, `✅ **Added!**\nNow tracking: **${text}**`, { parse_mode: "Markdown" });
        else if (result === "LIMIT_REACHED") bot.sendMessage(chatId, "⚠️ Limit reached.");
        else if (result === "DUPLICATE") bot.sendMessage(chatId, "⚠️ Already tracking this.");
        userState[chatId] = { step: null };
        return;
    }

    // --- VIEW WATCHLIST ---
    if (text === "📋 View Watchlist") {
        const db = loadDB();
        const wallets = db[chatId] || [];
        if (wallets.length === 0) return bot.sendMessage(chatId, "📭 Watchlist empty.");
        const buttons = wallets.map(w => [{ text: `🗑 Remove ${w.name}`, callback_data: `DEL_${w.address}` }]);
        bot.sendMessage(chatId, `📋 **Your Watchlist (${wallets.length}/${MAX_WALLETS}):**`, { reply_markup: { inline_keyboard: buttons } });
    }

    if (text === "🚀 Scan My List") {
        bot.sendMessage(chatId, "🔎 Scanning...");
        await scanUser(chatId, true);
    }
    
    if (text === "❓ Help") {
        bot.sendMessage(chatId, "ℹ️ **Info:**\n• Track up to 5 wallets.\n• Data is private to you.\n• Alerts are instant.");
    }
});

bot.on('callback_query', (q) => {
    if (q.data.startsWith('DEL_')) {
        removeWallet(q.message.chat.id, q.data.replace('DEL_', ''));
        bot.answerCallbackQuery(q.id, { text: "Deleted" });
        bot.deleteMessage(q.message.chat.id, q.message.message_id);
    }
});

// --- TRACKER LOGIC ---
async function scanUser(chatId, isManual = false) {
    const db = loadDB();
    const wallets = db[chatId];
    if (!wallets || wallets.length === 0) {
        if (isManual) bot.sendMessage(chatId, "📭 No wallets.");
        return;
    }

    let updatesFound = false;
    const updatedWallets = [];

    for (const w of wallets) {
        try {
            // DEBUG LOG:
            console.log(`Checking ${w.name}...`);

            const res = await axios.get(`https://data-api.polymarket.com/activity`, {
                params: { user: w.address, limit: 1, sortBy: 'TIMESTAMP', sortDirection: 'DESC' }
            });

            if (res.data.length > 0) {
                const trade = res.data[0];
                const currentHash = trade.id || trade.transactionHash; 

                if (w.lastHash && w.lastHash !== currentHash) {
                    if (trade.type === "TRADE") {
                        const side = trade.side; 
                        
                        // FORMATTING: Prioritize 'outcome', then 'asset'. Ignore raw numbers.
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
                } else if (!w.lastHash) {
                    console.log("   ✅ Initial Sync");
                }
                w.lastHash = currentHash;
            }
        } catch (e) {
            console.error(`   ❗ ERROR checking ${w.name}:`, e.message);
        }
        updatedWallets.push(w);
    }

    db[chatId] = updatedWallets;
    saveDB(db);

    if (isManual && !updatesFound) bot.sendMessage(chatId, "✅ No new trades.");
}

// --- GLOBAL AUTO-SCANNER ---
setInterval(async () => {
    const db = loadDB();
    const users = Object.keys(db);
    if (users.length > 0) {
        // Heartbeat dot in terminal
        process.stdout.write("."); 
        for (const id of users) await scanUser(id, false);
    }
}, CHECK_INTERVAL);

console.log("Cloud Watcher Running...");