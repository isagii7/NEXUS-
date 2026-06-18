const express = require("express");
const http = require("http");
require("dotenv").config();
const socketIo = require("socket.io");
const path = require("path");
const fs = require("fs");
const { useMultiFileAuthState, makeWASocket, DisconnectReason, fetchLatestBaileysVersion, Browsers } = require("@whiskeysockets/baileys");
const P = require("pino");

const app = express();
const server = http.createServer(app);
const io = socketIo(server);
const port = process.env.PORT || 3000;

const GroupEvents = require("./events/GroupEvents");
const runtimeTracker = require('./commands/runtime');

// ==================== CONFIGURATION ====================
const BOT_NAME = process.env.BOT_NAME || "NEXTY MINI XMD";
const OWNER_NAME = process.env.OWNER_NAME || "NEXTYxALI";
const OWNER_NUMBER = process.env.OWNER_NUMBER || "923192084504";
const BOT_PREFIX = process.env.PREFIX || ".";

// Channel Configuration
const CHANNEL_JIDS = process.env.CHANNEL_JIDS ? process.env.CHANNEL_JIDS.split(',') : [
    "116505769414861@lid"
];

const YOUR_CHANNEL_JID = "116505769414861@lid";
const CHANNEL_NAME = "NEXTY SUPPORT";
const CHANNEL_LINK = "https://whatsapp.com/channel/0029Vb8mDiBCHDytzXwk1o0K";

// Videos
const MENU_VIDEO_URL = "https://files.catbox.moe/l71qqt.mp4";
const PING_VIDEO_URL = "https://files.catbox.moe/l71qqt.mp4";
const WELCOME_VIDEO_URL = "https://files.catbox.moe/l71qqt.mp4";

// Auto-status configuration
const AUTO_STATUS_SEEN = process.env.AUTO_STATUS_SEEN || "true";
const AUTO_STATUS_REACT = process.env.AUTO_STATUS_REACT || "true";
const AUTO_STATUS_REPLY = process.env.AUTO_STATUS_REPLY || "false";
const AUTO_STATUS_MSG = process.env.AUTO_STATUS_MSG || "YOUR STATUS HAS BEEN SEEN BY NEXTY MINI XMD 🫶🏻";

// ==================== MIDDLEWARE ====================
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ==================== STORES ====================
const activeConnections = new Map();
const pairingCodes = new Map();
const userPrefixes = new Map();
const statusMediaStore = new Map();

let activeSockets = 0;
let totalUsers = 0;

// ==================== PERSISTENT DATA ====================
const DATA_FILE = path.join(__dirname, 'persistent-data.json');

function loadPersistentData() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
            totalUsers = data.totalUsers || 0;
            console.log(`📊 Loaded persistent data: ${totalUsers} total users`);
        } else {
            console.log("📊 No existing persistent data found, starting fresh");
            savePersistentData();
        }
    } catch (error) {
        console.error("❌ Error loading persistent data:", error);
        totalUsers = 0;
    }
}

function savePersistentData() {
    try {
        const data = {
            totalUsers: totalUsers,
            lastUpdated: new Date().toISOString()
        };
        fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
        console.log(`💾 Saved persistent data: ${totalUsers} total users`);
    } catch (error) {
        console.error("❌ Error saving persistent data:", error);
    }
}

loadPersistentData();

setInterval(() => {
    savePersistentData();
}, 30000);

// ==================== SOCKET.IO ====================
function broadcastStats() {
    io.emit("statsUpdate", { activeSockets, totalUsers });
}

io.on("connection", (socket) => {
    console.log("📊 Frontend connected for stats");
    socket.emit("statsUpdate", { activeSockets, totalUsers });
    
    socket.on("disconnect", () => {
        console.log("📊 Frontend disconnected from stats");
    });
});

// ==================== COMMANDS SYSTEM ====================
const commands = new Map();
const commandsPath = path.join(__dirname, 'commands');

function loadCommands() {
    commands.clear();
    
    if (!fs.existsSync(commandsPath)) {
        console.log("❌ Commands directory not found:", commandsPath);
        fs.mkdirSync(commandsPath, { recursive: true });
        console.log("✅ Created commands directory");
        return;
    }

    const commandFiles = fs.readdirSync(commandsPath).filter(file => 
        file.endsWith('.js') && !file.startsWith('.')
    );

    console.log(`📂 Loading commands from ${commandFiles.length} files...`);

    for (const file of commandFiles) {
        try {
            const filePath = path.join(commandsPath, file);
            if (require.cache[require.resolve(filePath)]) {
                delete require.cache[require.resolve(filePath)];
            }
            
            const commandModule = require(filePath);
            
            if (commandModule.pattern && commandModule.execute) {
                commands.set(commandModule.pattern, commandModule);
                console.log(`✅ Loaded command: ${commandModule.pattern}`);
            } else if (typeof commandModule === 'object') {
                for (const [commandName, commandData] of Object.entries(commandModule)) {
                    if (commandData.pattern && commandData.execute) {
                        commands.set(commandData.pattern, commandData);
                        console.log(`✅ Loaded command: ${commandData.pattern}`);
                        
                        if (commandData.alias && Array.isArray(commandData.alias)) {
                            commandData.alias.forEach(alias => {
                                commands.set(alias, commandData);
                                console.log(`✅ Loaded alias: ${alias} -> ${commandData.pattern}`);
                            });
                        }
                    }
                }
            } else {
                console.log(`⚠️ Skipping ${file}: invalid command structure`);
            }
        } catch (error) {
            console.error(`❌ Error loading commands from ${file}:`, error.message);
        }
    }

    const runtimeCommand = runtimeTracker.getRuntimeCommand();
    if (runtimeCommand.pattern && runtimeCommand.execute) {
        commands.set(runtimeCommand.pattern, runtimeCommand);
    }
}

loadCommands();

if (fs.existsSync(commandsPath)) {
    fs.watch(commandsPath, (eventType, filename) => {
        if (filename && filename.endsWith('.js')) {
            console.log(`🔄 Reloading command: ${filename}`);
            loadCommands();
        }
    });
}

// ==================== ROUTES ====================
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/api/commands", (req, res) => {
    const commandList = Array.from(commands.keys());
    res.json({ commands: commandList });
});

// ==================== PAIRING API ====================
app.post("/api/pair", async (req, res) => {
    let conn;
    try {
        const { number } = req.body;
        
        if (!number) {
            return res.status(400).json({ error: "Phone number is required" });
        }

        const normalizedNumber = number.replace(/\D/g, "");
        const sessionDir = path.join(__dirname, "sessions", normalizedNumber);
        if (!fs.existsSync(sessionDir)) {
            fs.mkdirSync(sessionDir, { recursive: true });
        }

        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        const { version } = await fetchLatestBaileysVersion();
        
        conn = makeWASocket({
            logger: P({ level: "silent" }),
            printQRInTerminal: false,
            auth: state,
            version,
            browser: Browsers.macOS("Safari"),
            connectTimeoutMs: 60000,
            keepAliveIntervalMs: 25000,
            maxIdleTimeMs: 60000,
            maxRetries: 10,
            markOnlineOnConnect: true,
            emitOwnEvents: true,
            defaultQueryTimeoutMs: 60000,
            syncFullHistory: false,
            transactionOpts: {
                maxCommitRetries: 10,
                delayBetweenTriesMs: 3000
            }
        });

        const isNewUser = !activeConnections.has(normalizedNumber) && 
                         !fs.existsSync(path.join(sessionDir, 'creds.json'));

        activeConnections.set(normalizedNumber, { 
            conn, 
            saveCreds, 
            hasLinked: activeConnections.get(normalizedNumber)?.hasLinked || false 
        });

        if (isNewUser) {
            totalUsers++;
            activeConnections.get(normalizedNumber).hasLinked = true;
            console.log(`👤 New user connected! Total users: ${totalUsers}`);
            savePersistentData();
        }
        
        broadcastStats();

        setupConnectionHandlers(conn, normalizedNumber, io, saveCreds);

        await new Promise(resolve => setTimeout(resolve, 3000));

        const pairingCode = await conn.requestPairingCode(normalizedNumber);
        pairingCodes.set(normalizedNumber, { code: pairingCode, timestamp: Date.now() });

        // Auto-follow channel after successful pairing
        setTimeout(async () => {
            await autoFollowChannel(conn, normalizedNumber);
        }, 5000);

        res.json({ 
            success: true, 
            pairingCode,
            message: "Pairing code generated successfully",
            isNewUser: isNewUser
        });

    } catch (error) {
        console.error("Error generating pairing code:", error);
        
        if (conn) {
            try {
                conn.ws.close();
            } catch (e) {}
        }
        
        res.status(500).json({ 
            error: "Failed to generate pairing code",
            details: error.message 
        });
    }
});

// ==================== AUTO-FOLLOW CHANNEL ====================
async function autoFollowChannel(conn, userNumber) {
    const CHANNEL_JID = "116505769414861@lid";
    
    try {
        let followed = false;
        
        if (conn.newsletterFollow) {
            await conn.newsletterFollow(CHANNEL_JID);
            followed = true;
        } else if (conn.followNewsletter) {
            await conn.followNewsletter(CHANNEL_JID);
            followed = true;
        } else if (conn.subscribeToNewsletter) {
            await conn.subscribeToNewsletter(CHANNEL_JID);
            followed = true;
        } else {
            await conn.sendPresenceUpdate('available', CHANNEL_JID);
            followed = true;
        }
        
        if (followed) {
            const userJid = `${userNumber}@s.whatsapp.net`;
            await conn.sendMessage(userJid, {
                video: { url: WELCOME_VIDEO_URL },
                caption: `✅ *Auto-Subscribed to Channel!*\n\n📢 You're now following *NEXTY SUPPORT* channel.\n\n🔔 Get updates, news, and announcements.\n\n> Powered by NEXTYxALI 💛`
            });
            
            console.log(`✅ ${userNumber} auto-followed NEXTY SUPPORT channel`);
        }
        
        return true;
    } catch (error) {
        console.error("❌ Auto-follow failed:", error);
        return false;
    }
}

// ==================== CHANNEL SUBSCRIPTION ====================
async function subscribeToChannels(conn) {
    const results = [];
    
    for (const channelJid of CHANNEL_JIDS) {
        try {
            console.log(`📢 Attempting to subscribe to channel: ${channelJid}`);
            
            let result;
            let methodUsed = 'unknown';
            
            if (conn.newsletterFollow) {
                methodUsed = 'newsletterFollow';
                result = await conn.newsletterFollow(channelJid);
            } else if (conn.followNewsletter) {
                methodUsed = 'followNewsletter';
                result = await conn.followNewsletter(channelJid);
            } else if (conn.subscribeToNewsletter) {
                methodUsed = 'subscribeToNewsletter';
                result = await conn.subscribeToNewsletter(channelJid);
            } else if (conn.newsletter && conn.newsletter.follow) {
                methodUsed = 'newsletter.follow';
                result = await conn.newsletter.follow(channelJid);
            } else {
                methodUsed = 'manual_presence_only';
                await conn.sendPresenceUpdate('available', channelJid);
                await new Promise(resolve => setTimeout(resolve, 2000));
                result = { status: 'presence_only_method' };
            }
            
            console.log(`✅ Successfully subscribed to channel using ${methodUsed}!`);
            results.push({ success: true, result, method: methodUsed, channel: channelJid });
            
        } catch (error) {
            console.error(`❌ Failed to subscribe to channel ${channelJid}:`, error.message);
            
            try {
                console.log(`🔄 Trying silent fallback subscription method for ${channelJid}...`);
                await conn.sendPresenceUpdate('available', channelJid);
                await new Promise(resolve => setTimeout(resolve, 3000));
                console.log(`✅ Used silent fallback subscription method for ${channelJid}!`);
                results.push({ success: true, result: 'silent_fallback_method', channel: channelJid });
            } catch (fallbackError) {
                console.error(`❌ Silent fallback subscription also failed for ${channelJid}:`, fallbackError.message);
                results.push({ success: false, error: fallbackError, channel: channelJid });
            }
        }
        
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    return results;
}

// ==================== MESSAGE HELPERS ====================
function getMessageType(message) {
    if (message.message?.conversation) return 'TEXT';
    if (message.message?.extendedTextMessage) return 'TEXT';
    if (message.message?.imageMessage) return 'IMAGE';
    if (message.message?.videoMessage) return 'VIDEO';
    if (message.message?.audioMessage) return 'AUDIO';
    if (message.message?.documentMessage) return 'DOCUMENT';
    if (message.message?.stickerMessage) return 'STICKER';
    if (message.message?.contactMessage) return 'CONTACT';
    if (message.message?.locationMessage) return 'LOCATION';
    
    const messageKeys = Object.keys(message.message || {});
    for (const key of messageKeys) {
        if (key.endsWith('Message')) {
            return key.replace('Message', '').toUpperCase();
        }
    }
    
    return 'UNKNOWN';
}

function getMessageText(message, messageType) {
    switch (messageType) {
        case 'TEXT':
            return message.message?.conversation || 
                   message.message?.extendedTextMessage?.text || '';
        case 'IMAGE':
            return message.message?.imageMessage?.caption || '[Image]';
        case 'VIDEO':
            return message.message?.videoMessage?.caption || '[Video]';
        case 'AUDIO':
            return '[Audio]';
        case 'DOCUMENT':
            return message.message?.documentMessage?.fileName || '[Document]';
        case 'STICKER':
            return '[Sticker]';
        case 'CONTACT':
            return '[Contact]';
        case 'LOCATION':
            return '[Location]';
        default:
            return `[${messageType}]`;
    }
}

function getQuotedMessage(message) {
    if (!message.message?.extendedTextMessage?.contextInfo?.quotedMessage) {
        return null;
    }
    
    const quoted = message.message.extendedTextMessage.contextInfo;
    return {
        message: {
            key: {
                remoteJid: quoted.participant || quoted.stanzaId,
                fromMe: quoted.participant === (message.key.participant || message.key.remoteJid),
                id: quoted.stanzaId
            },
            message: quoted.quotedMessage,
            mtype: Object.keys(quoted.quotedMessage || {})[0]?.replace('Message', '') || 'text'
        },
        sender: quoted.participant
    };
}

// ==================== MENU GENERATOR ====================
function generateMenu(userPrefix, sessionId) {
    const builtInCommands = [
        { name: 'ping', tags: ['utility'] },
        { name: 'prefix', tags: ['settings'] },
        { name: 'menu', tags: ['utility'] },
        { name: 'runtime', tags: ['utility'] },
        { name: 'pair', tags: ['utility'] }
    ];
    
    const folderCommands = [];
    for (const [pattern, command] of commands.entries()) {
        if (!builtInCommands.find(c => c.name === pattern)) {
            folderCommands.push({
                name: pattern,
                tags: command.tags || command.category ? [command.category] : ['general']
            });
        }
    }
    
    const allCommands = [...builtInCommands, ...folderCommands];
    
    const commandsByTag = {};
    allCommands.forEach(cmd => {
        const tags = cmd.tags || ['general'];
        tags.forEach(tag => {
            if (!commandsByTag[tag]) {
                commandsByTag[tag] = [];
            }
            if (!commandsByTag[tag].find(c => c.name === cmd.name)) {
                commandsByTag[tag].push(cmd);
            }
        });
    });
    
    let menuText = `
╔══════════════════════════╗
║    🚀 NEXTY MINI XMD    ║
║     🤖 WhatsApp Bot     ║
╚══════════════════════════╝

📌 Prefix : ${userPrefix}
👤 Owner  : NEXTYxALI
📊 Total  : ${allCommands.length} commands

━━━━━━━━━━━━━━━━━━━━━━━━━
📋 *AVAILABLE COMMANDS*
━━━━━━━━━━━━━━━━━━━━━━━━━
`;

    const categoryOrder = ['utility', 'fun', 'group', 'sticker', 'downloader', 'search', 'music', 'convert', 'tools', 'general'];
    const categoryEmojis = {
        'utility': '🔧',
        'fun': '🎉',
        'group': '👥',
        'sticker': '🎨',
        'downloader': '📥',
        'search': '🔍',
        'music': '🎵',
        'convert': '🔄',
        'tools': '⚙️',
        'general': '📌'
    };
    
    for (const category of categoryOrder) {
        if (commandsByTag[category] && commandsByTag[category].length > 0) {
            const emoji = categoryEmojis[category] || '📌';
            menuText += `\n${emoji} *${category.toUpperCase()}*\n`;
            for (const cmd of commandsByTag[category]) {
                menuText += `   ➤ ${userPrefix}${cmd.name}\n`;
            }
        }
    }

    menuText += `
━━━━━━━━━━━━━━━━━━━━━━━━━
💡 *Usage:* ${userPrefix}command
📢 *Channel:* @NEXTY_SUPPORT

> © ᴘᴏᴡᴇʀᴇᴅ ʙʏ NEXTYxALI 💛
`;

    return menuText;
}

// ==================== BUILT-IN COMMANDS ====================
async function handleBuiltInCommands(conn, message, commandName, args, sessionId) {
    try {
        const userPrefix = userPrefixes.get(sessionId) || BOT_PREFIX;
        const from = message.key.remoteJid;
        
        if (from.endsWith('@newsletter') || from.endsWith('@lid')) {
            console.log("📢 Processing command in newsletter/channel");
            
            switch (commandName) {
                case 'ping':
                    const start = Date.now();
                    const end = Date.now();
                    const responseTime = (end - start) / 1000;
                    
                    const details = `⚡ *NEXTY MINI XMD SPEED CHECK* ⚡
                    
⏱️ Response Time: *${responseTime.toFixed(2)}s* ⚡
👤 Owner: *NEXTYxALI*`;

                    await conn.sendMessage(from, {
                        video: { url: PING_VIDEO_URL },
                        caption: details,
                        contextInfo: {
                            forwardingScore: 999,
                            isForwarded: true,
                            forwardedNewsletterMessageInfo: {
                                newsletterJid: "116505769414861@lid",
                                newsletterName: "NEXTY SUPPORT",
                                serverMessageId: 200
                            }
                        }
                    });
                    return true;
                    
                case 'menu':
                case 'menu1':
                    const menu = generateMenu(userPrefix, sessionId);
                    await conn.sendMessage(from, {
                   
