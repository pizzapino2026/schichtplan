const express = require('express');
const https = require('https');
const http = require('http');
const querystring = require('querystring');
const { Client } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

// Twilio config
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || '';
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || '';
const TWILIO_WHATSAPP_FROM = process.env.TWILIO_WHATSAPP_FROM || 'whatsapp:+14155238886';
const DATABASE_URL = process.env.DATABASE_URL || '';
const APP_URL = process.env.APP_URL || 'https://schichtplan-ufys.onrender.com';

// Chef-Benachrichtigungen bei jeder Eintragung/Austragung
const CHEF_NUMBERS = ['+4915901395627', '+4916607746498'];

app.use(express.json());
app.use(express.static(__dirname + '/public'));

// DB client
let db;
async function getDb() {
  if (!db) {
    db = new Client({
      connectionString: DATABASE_URL,
      ssl: DATABASE_URL ? { rejectUnauthorized: false } : false
    });
    await db.connect();
    // Create table if not exists
    await db.query(`
      CREATE TABLE IF NOT EXISTS shifts (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        standort TEXT NOT NULL,
        date TEXT NOT NULL,
        type TEXT NOT NULL,
        slot_number INTEGER NOT NULL,
        start_time TEXT NOT NULL,
        end_time TEXT NOT NULL,
        phone TEXT DEFAULT '',
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);
  }
  return db;
}

// ===== HELPERS =====
function getMaxSlots(dateStr, standort) {
  const day = new Date(dateStr).getDay();
  const extraFix = standort === 'esslingen' ? 1 : 0;
  if (day === 5 || day === 6 || day === 0) return { fix: 2 + extraFix, bereit: 1 };
  return { fix: 1 + extraFix, bereit: 1 };
}

function getSlotTime(dateStr, type, slotNumber) {
  const day = new Date(dateStr).getDay();
  const endTime = (day === 5 || day === 6) ? '23:30' : '21:30';
  if (type === 'fix' && slotNumber === 1) return { start: '16:15', end: endTime };
  return { start: '17:15', end: endTime };
}

function formatDateLong(dateStr) {
  const DAYS = ['Sonntag','Montag','Dienstag','Mittwoch','Donnerstag','Freitag','Samstag'];
  const d = new Date(dateStr);
  return `${DAYS[d.getDay()]}, ${String(d.getDate()).padStart(2,'0')}.${String(d.getMonth()+1).padStart(2,'0')}.${d.getFullYear()}`;
}

function buildCalendarLink(name, standort, dateStr, startTime, endTime) {
  const params = new URLSearchParams({ name, standort, date: dateStr, start: startTime, end: endTime });
  return `${APP_URL}/kalender.ics?${params.toString()}`;
}

function normalize(str) {
  return str.toLowerCase().replace(/\s+/g, ' ').trim();
}

function notifyChefs(message) {
  CHEF_NUMBERS.forEach(num => sendWhatsApp(num, message));
}

function sendWhatsApp(toNumber, message) {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) return;
  let num = toNumber.replace(/[\s\-\(\)]/g, '');
  if (num.startsWith('0')) num = '+49' + num.slice(1);
  if (!num.startsWith('+')) num = '+49' + num;

  const postData = querystring.stringify({
    From: TWILIO_WHATSAPP_FROM,
    To: `whatsapp:${num}`,
    Body: message
  });

  const options = {
    hostname: 'api.twilio.com',
    path: `/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`,
    method: 'POST',
    auth: `${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(postData)
    }
  };

  const req = https.request(options, (res) => {
    let body = '';
    res.on('data', chunk => body += chunk);
    res.on('end', () => console.log('[WhatsApp] Sent:', res.statusCode));
  });
  req.on('error', e => console.error('[WhatsApp] Error:', e.message));
  req.write(postData);
  req.end();
}

// ===== ICS CALENDAR =====
app.get('/kalender.ics', (req, res) => {
  const { name, standort, date, start, end } = req.query;
  if (!name || !date || !start || !end) return res.status(400).send('Fehlende Parameter');

  const d = new Date(date);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth()+1).padStart(2,'0');
  const dd = String(d.getDate()).padStart(2,'0');
  const dtStart = `${yyyy}${mm}${dd}T${start.replace(':','')}00`;
  const dtEnd   = `${yyyy}${mm}${dd}T${end.replace(':','')}00`;
  const standortName = standort ? standort.charAt(0).toUpperCase() + standort.slice(1) : '';
  const uid = `${dtStart}-${Math.random().toString(36).substr(2,9)}@pizzapino.de`;

  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Pizza Pino//Schichtplan//DE',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `DTSTART:${dtStart}`,
    `DTEND:${dtEnd}`,
    `SUMMARY:Pizza Pino ${standortName} - Schicht`,
    `DESCRIPTION:Fahrerschicht fuer ${name}`,
    `LOCATION:Pizza Pino ${standortName}`,
    `UID:${uid}`,
    'STATUS:CONFIRMED',
    'TRANSP:OPAQUE',
    'END:VEVENT',
    'END:VCALENDAR'
  ].join('\r\n');

  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="schicht-${date}.ics"`);
  res.send(ics);
});

// ===== GET ALL SHIFTS =====
app.get('/api/shifts', async (req, res) => {
  try {
    const db = await getDb();
    const result = await db.query('SELECT * FROM shifts ORDER BY date ASC, type ASC, slot_number ASC');
    const shifts = result.rows.map(r => ({
      name: r.name,
      standort: r.standort,
      date: r.date,
      type: r.type,
      slotNumber: r.slot_number,
      startTime: r.start_time,
      endTime: r.end_time,
      phone: r.phone,
      createdAt: r.created_at
    }));
    res.json(shifts);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

// ===== REGISTER =====
app.post('/api/shifts/register', async (req, res) => {
  const { name, standort, date, type, phone } = req.body;
  if (!name || !standort || !date || !type) return res.status(400).json({ error: 'Alle Felder sind erforderlich' });

  const d = new Date(date);
  if (d.getDay() === 2) return res.status(400).json({ error: 'Dienstag ist Ruhetag' });

  // Max 2 Kalenderwochen ab heute
  const now = new Date();
  const dow = now.getDay();
  const monday = new Date(now);
  monday.setDate(now.getDate() - (dow === 0 ? 6 : dow - 1));
  monday.setHours(0,0,0,0);
  const maxDate = new Date(monday);
  maxDate.setDate(monday.getDate() + 20); // Ende KW+2 (Sonntag)
  maxDate.setHours(23,59,59,999);
  if (d > maxDate) {
    return res.status(400).json({ error: '⛔ Eintragungen sind nur für die aktuelle KW und die nächsten 2 Kalenderwochen möglich.' });
  }

  try {
    const db = await getDb();

    // Max 3 Eintragungen pro Fahrer pro Kalenderwoche
    const weekMonday = new Date(d);
    const wd = d.getDay();
    weekMonday.setDate(d.getDate() - (wd === 0 ? 6 : wd - 1));
    weekMonday.setHours(0,0,0,0);
    const weekSunday = new Date(weekMonday);
    weekSunday.setDate(weekMonday.getDate() + 6);
    weekSunday.setHours(23,59,59,999);
    const mondayStr = weekMonday.toISOString().split('T')[0];
    const sundayStr = weekSunday.toISOString().split('T')[0];

    const weekCount = await db.query(
      `SELECT COUNT(*) FROM shifts WHERE LOWER(TRIM(name))=$1 AND standort=$2 AND date >= $3 AND date <= $4`,
      [normalize(name), standort, mondayStr, sundayStr]
    );
    if (parseInt(weekCount.rows[0].count) >= 3) {
      return res.status(409).json({ error: `⛔ ${name} ist diese Woche bereits 3x eingetragen – maximale Eintragungen pro Woche erreicht.` });
    }

    // Duplicate check
    const dup = await db.query(
      'SELECT id FROM shifts WHERE LOWER(TRIM(name))=$1 AND standort=$2 AND date=$3 AND type=$4',
      [normalize(name), standort, date, type]
    );
    if (dup.rows.length > 0) {
      return res.status(409).json({ error: `❌ ${name} ist für diese Schicht bereits eingetragen!` });
    }

    // Capacity check
    const fixRes = await db.query('SELECT COUNT(*) FROM shifts WHERE standort=$1 AND date=$2 AND type=$3', [standort, date, 'fix']);
    const bereitRes = await db.query('SELECT COUNT(*) FROM shifts WHERE standort=$1 AND date=$2 AND type=$3', [standort, date, 'bereitschaft']);
    const fixCount = parseInt(fixRes.rows[0].count);
    const bereitCount = parseInt(bereitRes.rows[0].count);
    const max = getMaxSlots(date, standort);

    if (type === 'fix' && fixCount >= max.fix) return res.status(409).json({ error: `Alle Fix-Plätze vergeben (max. ${max.fix})` });
    if (type === 'bereitschaft' && bereitCount >= max.bereit) return res.status(409).json({ error: 'Bereitschafts-Platz bereits vergeben' });

    const slotNumber = type === 'fix' ? fixCount + 1 : bereitCount + 1;
    const time = getSlotTime(date, type, slotNumber);

    await db.query(
      'INSERT INTO shifts (name, standort, date, type, slot_number, start_time, end_time, phone) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [name, standort, date, type, slotNumber, time.start, time.end, phone || '']
    );

    // WhatsApp
    if (phone) {
      const dateLong = formatDateLong(date);
      const calLink = buildCalendarLink(name, standort, date, time.start, time.end);
      const standortName = standort.charAt(0).toUpperCase() + standort.slice(1);
      const typeLabel = type === 'fix' ? '✅ Fix-Fahrer' : '📞 Bereitschaft';
      const msg = `🍕 *Pizza Pino ${standortName}*\n\nHallo ${name}! Du bist eingetragen:\n\n📅 ${dateLong}\n⏰ ${time.start} – ${time.end} Uhr\n👤 ${typeLabel}\n\n📅 Zum Kalender hinzufügen:\n${calLink}\n\n_Pizza Pino Schichtplan_`;
      sendWhatsApp(phone, msg);
    }

    // Chef-Benachrichtigung
    const standortName = standort.charAt(0).toUpperCase() + standort.slice(1);
    const typeLabel = type === 'fix' ? '✅ Fix-Fahrer' : '📞 Bereitschaft';
    const chefMsg = `🍕 *Pizza Pino ${standortName} – Neue Eintragung*\n\n👤 ${name}\n📅 ${formatDateLong(date)}\n⏰ ${time.start} – ${time.end} Uhr\n${typeLabel}`;
    notifyChefs(chefMsg);

    const calLink = buildCalendarLink(name, standort, date, time.start, time.end);
    res.json({
      success: true,
      message: `Erfolgreich eingetragen! Deine Schicht: ${time.start} – ${time.end} Uhr${phone ? ' – WhatsApp wird gesendet 📱' : ''}`,
      calLink
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

// ===== UNREGISTER =====
app.delete('/api/shifts/unregister', async (req, res) => {
  const { name, standort, date, type } = req.body;
  try {
    const db = await getDb();
    const result = await db.query(
      'DELETE FROM shifts WHERE LOWER(TRIM(name))=$1 AND standort=$2 AND date=$3 AND type=$4 RETURNING *',
      [normalize(name), standort, date, type]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Eintrag nicht gefunden' });

    // Recalculate slot numbers
    const remaining = await db.query(
      'SELECT id FROM shifts WHERE standort=$1 AND date=$2 AND type=$3 ORDER BY slot_number ASC',
      [standort, date, type]
    );
    for (let i = 0; i < remaining.rows.length; i++) {
      const slotNumber = i + 1;
      const time = getSlotTime(date, type, slotNumber);
      await db.query(
        'UPDATE shifts SET slot_number=$1, start_time=$2, end_time=$3 WHERE id=$4',
        [slotNumber, time.start, time.end, remaining.rows[i].id]
      );
    }

    // Chef-Benachrichtigung
    const removed = result.rows[0];
    const standortName2 = removed.standort.charAt(0).toUpperCase() + removed.standort.slice(1);
    const typeLabel2 = removed.type === 'fix' ? '✅ Fix-Fahrer' : '📞 Bereitschaft';
    const chefMsg2 = `⚠️ *Pizza Pino ${standortName2} – Austragung*\n\n👤 ${removed.name}\n📅 ${formatDateLong(removed.date)}\n⏰ ${removed.start_time} – ${removed.end_time} Uhr\n${typeLabel2}`;
    notifyChefs(chefMsg2);

    res.json({ success: true, message: 'Erfolgreich ausgetragen!' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

// ===== ADMIN GET =====
app.get('/api/admin/shifts', async (req, res) => {
  if (req.query.password !== 'pizzapino2024') return res.status(401).json({ error: 'Falsches Passwort' });
  try {
    const db = await getDb();
    const result = await db.query('SELECT * FROM shifts ORDER BY date ASC, type ASC, slot_number ASC');
    const shifts = result.rows.map(r => ({
      id: r.id,
      name: r.name,
      standort: r.standort,
      date: r.date,
      type: r.type,
      slotNumber: r.slot_number,
      startTime: r.start_time,
      endTime: r.end_time,
      phone: r.phone,
      createdAt: r.created_at
    }));
    res.json(shifts);
  } catch (e) {
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

// ===== ADMIN MANUAL ASSIGN =====
app.post('/api/admin/shifts/assign', async (req, res) => {
  const { password, name, phone, standort, date, type } = req.body;
  if (password !== 'pizzapino2024') return res.status(401).json({ error: 'Falsches Passwort' });
  if (!name || !standort || !date || !type) return res.status(400).json({ error: 'Fehlende Felder' });

  try {
    const db = await getDb();

    // Duplicate check
    const dup = await db.query(
      'SELECT id FROM shifts WHERE LOWER(TRIM(name))=$1 AND standort=$2 AND date=$3 AND type=$4',
      [normalize(name), standort, date, type]
    );
    if (dup.rows.length > 0) return res.status(409).json({ error: `${name} ist für diese Schicht bereits eingetragen!` });

    // Capacity check
    const fixRes = await db.query('SELECT COUNT(*) FROM shifts WHERE standort=$1 AND date=$2 AND type=$3', [standort, date, 'fix']);
    const bereitRes = await db.query('SELECT COUNT(*) FROM shifts WHERE standort=$1 AND date=$2 AND type=$3', [standort, date, 'bereitschaft']);
    const fixCount = parseInt(fixRes.rows[0].count);
    const bereitCount = parseInt(bereitRes.rows[0].count);
    const max = getMaxSlots(date, standort);

    if (type === 'fix' && fixCount >= max.fix) return res.status(409).json({ error: 'Alle Fix-Plätze bereits vergeben' });
    if (type === 'bereitschaft' && bereitCount >= max.bereit) return res.status(409).json({ error: 'Bereitschafts-Platz bereits vergeben' });

    const slotNumber = type === 'fix' ? fixCount + 1 : bereitCount + 1;
    const time = getSlotTime(date, type, slotNumber);

    await db.query(
      'INSERT INTO shifts (name, standort, date, type, slot_number, start_time, end_time, phone) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [name, standort, date, type, slotNumber, time.start, time.end, phone || '']
    );

    // WhatsApp an Fahrer
    if (phone) {
      const standortName = standort.charAt(0).toUpperCase() + standort.slice(1);
      const typeLabel = type === 'fix' ? '✅ Fix-Fahrer' : '📞 Bereitschaft';
      const calLink = buildCalendarLink(name, standort, date, time.start, time.end);
      const msg = `🍕 *Pizza Pino ${standortName}*\n\nHallo ${name}! Du wurdest vom Chef eingetragen:\n\n📅 ${formatDateLong(date)}\n⏰ ${time.start} – ${time.end} Uhr\n👤 ${typeLabel}\n\n📅 Zum Kalender:\n${calLink}`;
      sendWhatsApp(phone, msg);
    }

    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

// ===== ADMIN DELETE =====
app.delete('/api/admin/shifts/:id', async (req, res) => {
  if (req.query.password !== 'pizzapino2024') return res.status(401).json({ error: 'Falsches Passwort' });
  try {
    const db = await getDb();
    const result = await db.query('DELETE FROM shifts WHERE id=$1 RETURNING *', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Nicht gefunden' });

    const removed = result.rows[0];
    const remaining = await db.query(
      'SELECT id FROM shifts WHERE standort=$1 AND date=$2 AND type=$3 ORDER BY slot_number ASC',
      [removed.standort, removed.date, removed.type]
    );
    for (let i = 0; i < remaining.rows.length; i++) {
      const slotNumber = i + 1;
      const time = getSlotTime(removed.date, removed.type, slotNumber);
      await db.query('UPDATE shifts SET slot_number=$1, start_time=$2, end_time=$3 WHERE id=$4',
        [slotNumber, time.start, time.end, remaining.rows[i].id]);
    }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Datenbankfehler' });
  }
});

app.listen(PORT, () => console.log(`🍕 Pizza Pino läuft auf http://localhost:${PORT}`));
