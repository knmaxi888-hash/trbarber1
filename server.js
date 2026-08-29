const express = require("express");
const path = require("path");
const { MongoClient } = require("mongodb");

const app = express();
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI || "";
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";

const HORARIOS = ["09:00","10:00","11:00","12:00","16:00","17:00","18:00","19:00","20:00","21:00","22:00"];

let db = null;
let reservations = null;

app.use(express.json());

app.use(function(req, res, next) {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") return res.sendStatus(200);
    next();
});

app.use(express.static(__dirname));

async function connectDB() {
    if (!MONGODB_URI) {
        console.log("[DB] No MONGODB_URI configurada");
        return;
    }
    try {
        const client = new MongoClient(MONGODB_URI);
        await client.connect();
        db = client.db("trbarber");
        reservations = db.collection("reservations");
        await reservations.createIndex({ date: 1 });
        console.log("[DB] Conectado a MongoDB");
    } catch (e) {
        console.error("[DB] Error conectando:", e.message);
    }
}

async function sendTelegram(text) {
    if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
    try {
        await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                chat_id: TELEGRAM_CHAT_ID,
                text: text,
                parse_mode: "Markdown"
            })
        });
    } catch (e) {
        console.error("[TG ERROR]", e.message);
    }
}

async function notifyNewReservation(r) {
    const msg = `🔔 *Nueva reserva*\n\n👤 ${r.name} ${r.apellido}\n📅 ${displayDate(r.date)} a las ${r.time}\n\nEstado: pendiente`;
    await sendTelegram(msg);
}

function displayDate(dateStr) {
    if (!dateStr) return "";
    if (dateStr.includes("-")) {
        const parts = dateStr.split("-");
        return parts[2] + "/" + parts[1] + "/" + parts[0];
    }
    return dateStr;
}

function getArgentinaDate() {
    const now = new Date();
    const offset = -3;
    const local = new Date(now.getTime() + offset * 60 * 60 * 1000 + now.getTimezoneOffset() * 60 * 1000);
    const y = local.getFullYear();
    const m = String(local.getMonth() + 1).padStart(2, "0");
    const d = String(local.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
}

async function dailyReport() {
    if (!reservations) return;
    const today = getArgentinaDate();
    const todayRes = await reservations.find({ date: today }).toArray();
    const pending = todayRes.filter(r => r.status === "pendiente");
    const confirmed = todayRes.filter(r => r.status === "confirmada");

    const horarios = todayRes.map(r => `${r.time} - ${r.name} ${r.apellido} [${r.status}]`).join("\n") || "Sin reservas hoy.";

    const msg = `📊 *Reporte diario - ${displayDate(today)}*\n\nTotal: ${todayRes.length}\nPendientes: ${pending.length}\nConfirmadas: ${confirmed.length}\n\n🕐 *Horarios:*\n${horarios}`;

    await sendTelegram(msg);
}

async function weeklyCleanup() {
    if (!reservations) return;
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const cutoff = weekAgo.toISOString();

    const oldRes = await reservations.find({ createdAt: { $lt: cutoff } }).toArray();

    if (oldRes.length > 0) {
        const horarios = oldRes.map(r => `${displayDate(r.date)} ${r.time} - ${r.name} ${r.apellido} [${r.status}]`).join("\n");

        const total = oldRes.length;
        const completed = oldRes.filter(r => r.status === "completada").length;
        const cancelled = oldRes.filter(r => r.status === "cancelada").length;

        const msg = `📋 *Reporte semanal*\n\n${total} reservas en la última semana\n✅ Completadas: ${completed}\n❌ Canceladas: ${cancelled}\n\n*Detalle:*\n${horarios}`;

        await sendTelegram(msg);

        await reservations.deleteMany({ createdAt: { $lt: cutoff } });
        console.log(`[CLEANUP] ${oldRes.length} reservas antiguas eliminadas`);
    } else {
        await sendTelegram("📋 *Reporte semanal*\n\nSin reservas en la última semana.");
    }
}

function scheduleJobs() {
    function getNextHourly() {
        const now = new Date();
        const target = new Date(now);
        target.setHours(target.getHours() + 1, 0, 0, 0);
        return target.getTime() - now.getTime();
    }

    function checkDailyReport() {
        const now = new Date();
        const offset = -3;
        const art = new Date(now.getTime() + offset * 60 * 60 * 1000 + now.getTimezoneOffset() * 60 * 1000);
        return art.getHours() === 23 && art.getMinutes() === 0;
    }

    function checkWeeklyCleanup() {
        const now = new Date();
        const offset = -3;
        const art = new Date(now.getTime() + offset * 60 * 60 * 1000 + now.getTimezoneOffset() * 60 * 1000);
        return art.getDay() === 1 && art.getHours() === 0 && art.getMinutes() === 0;
    }

    setInterval(async () => {
        if (checkDailyReport()) {
            console.log("[CRON] Reporte diario");
            await dailyReport();
        }
        if (checkWeeklyCleanup()) {
            console.log("[CRON] Limpieza semanal");
            await weeklyCleanup();
        }
    }, 60000);

    console.log("[CRON] Jobs programados (chequeo cada minuto)");
}

app.get("/api/reservations", async (req, res) => {
    if (reservations) {
        const data = await reservations.find({}).sort({ createdAt: -1 }).toArray();
        res.json(data);
    } else {
        res.json([]);
    }
});

app.get("/api/reserved-times/:date", async (req, res) => {
    const date = req.params.date;
    if (reservations) {
        const reserved = await reservations
            .find({ date: date, status: { $ne: "cancelada" } })
            .toArray();
        res.json(reserved.map(r => r.time));
    } else {
        res.json([]);
    }
});

app.post("/api/reservations", async (req, res) => {
    const newReservation = {
        id: Date.now(),
        name: req.body.name,
        apellido: req.body.apellido,
        date: req.body.date,
        time: req.body.time,
        status: "pendiente",
        payment: "pendiente",
        createdAt: new Date().toISOString()
    };
    if (reservations) {
        await reservations.insertOne(newReservation);
    }
    await notifyNewReservation(newReservation);
    res.json({ success: true, reservation: newReservation });
});

app.put("/api/reservations/:id", async (req, res) => {
    if (reservations) {
        const id = parseInt(req.params.id);
        const update = {};
        if (req.body.status) update.status = req.body.status;
        if (req.body.payment) update.payment = req.body.payment;
        await reservations.updateOne({ id: id }, { $set: update });
        res.json({ success: true });
    } else {
        res.status(500).json({ error: "DB not connected" });
    }
});

app.delete("/api/reservations/:id", async (req, res) => {
    if (reservations) {
        const id = parseInt(req.params.id);
        await reservations.deleteOne({ id: id });
        res.json({ success: true });
    } else {
        res.status(500).json({ error: "DB not connected" });
    }
});

app.get("/api/available-times/:date", async (req, res) => {
    const date = req.params.date;
    if (reservations) {
        const reserved = await reservations
            .find({ date: date, status: { $ne: "cancelada" } })
            .toArray();
        const reservedTimes = reserved.map(r => r.time);
        res.json(HORARIOS.filter(h => !reservedTimes.includes(h)));
    } else {
        res.json(HORARIOS);
    }
});

app.get("/qr", (req, res) => {
    res.sendFile(path.join(__dirname, "qr.html"));
});

app.listen(PORT, async () => {
    console.log(`TR BARBER Server corriendo en http://localhost:${PORT}`);
    console.log(`Admin: http://localhost:${PORT}/admin.html`);
    await connectDB();
    scheduleJobs();
});
