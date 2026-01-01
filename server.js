require('dotenv').config();
const express = require('express');
const http = require('http');
const mongoose = require('mongoose');
const socketIo = require('socket.io');
const TelegramBot = require('node-telegram-bot-api');
const cors = require('cors');
const path = require('path');

// --- Config ---
const app = express();
const server = http.createServer(app);
const io = socketIo(server);
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: false });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Database Connection ---
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('✅ MongoDB Connected'))
    .catch(err => console.error('❌ DB Error:', err));

const Device = mongoose.model('Device', new mongoose.Schema({
    identifier: { type: String, required: true, unique: true },
    name: { type: String, default: 'بدون نام' },
    lastHeartbeat: { type: Date, default: Date.now },
    status: { type: String, enum: ['online', 'offline'], default: 'online' },
    alertSent: { type: Boolean, default: false }
}));

// --- Middleware Security ---
const authAdd = (req, res, next) => {
    if (req.headers['x-secret'] === process.env.SECRET_ADD) next();
    else res.status(401).json({ error: 'رمز افزودن/پینگ اشتباه است' });
};

const authDelete = (req, res, next) => {
    if (req.headers['x-secret'] === process.env.SECRET_DELETE) next();
    else res.status(401).json({ error: 'رمز حذف اشتباه است' });
};

// --- Watchdog Logic (10 Min Check) ---
setInterval(async () => {
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000);
    try {
        const offlineDevices = await Device.find({
            lastHeartbeat: { $lt: tenMinAgo },
            $or: [{ status: 'online' }, { alertSent: false }]
        });

        for (const dev of offlineDevices) {
            if (dev.status === 'online') {
                dev.status = 'offline';
                io.emit('update', dev);
            }
            if (!dev.alertSent) {
                const msg = `⚠️ **Alert: Device Down**\n🆔 ${dev.identifier}\n📌 ${dev.name}\n⏰ 10+ Min Inactive`;
                if(process.env.ADMIN_ID) bot.sendMessage(process.env.ADMIN_ID, msg);
                if(process.env.CHANNEL_ID) bot.sendMessage(process.env.CHANNEL_ID, msg);
                dev.alertSent = true;
            }
            await dev.save();
        }
    } catch (e) { console.error('Watchdog Error:', e); }
}, 60000); // Check every 1 minute

// --- Routes ---
// دریافت لیست
app.get('/api/devices', async (req, res) => {
    res.json(await Device.find({}).sort({ status: -1, lastHeartbeat: -1 }));
});

// پینگ / افزودن (نیاز به رمز افزودن)
app.post('/api/ping', authAdd, async (req, res) => {
    const { identifier, name } = req.body;
    if (!identifier) return res.status(400).json({ error: 'شناسه الزامی است' });

    let dev = await Device.findOne({ identifier });
    if (!dev) {
        dev = new Device({ identifier, name: name || identifier });
    } else {
        dev.lastHeartbeat = new Date();
        dev.status = 'online';
        dev.alertSent = false;
        if (name) dev.name = name;
    }
    await dev.save();
    io.emit('update', dev);
    res.json({ status: 'ok' });
});

// حذف (نیاز به رمز حذف)
app.delete('/api/device/:id', authDelete, async (req, res) => {
    await Device.findOneAndDelete({ identifier: req.params.id });
    io.emit('delete', req.params.id);
    res.json({ status: 'deleted' });
});

// --- Start ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server on ${PORT}`));
