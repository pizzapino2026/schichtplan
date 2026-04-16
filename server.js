const express = require('express');
const fs = require('fs');
const path = require('path');
const https = require('https');
const querystring = require('querystring');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');

// Twilio config from environment variables
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || '';
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || '';
const TWILIO_WHATSAPP_FROM = process.env.TWILIO_WHATSAPP_FROM || 'whatsapp:+14155238886';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

if (!fs.existsSync(DATA_FILE)) {
  fs.writeFileSync(DATA_FILE, JSON.stringify({ shifts: [] }, null, 2));
}

function loadData() {
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}
function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function getMaxSlots(dateStr, standort) {
  const d = new Date(dateStr);
  const day = d.getDay();
  const extraFix = standort === 'esslingen' ? 1 : 0;
  if (day === 5 || day === 6 || day === 0) {
    return { fix: 2 + extraFix, bereit: 1 };
  }
  return { fix: 1 + extraFix, bereit: 1 };
}

function getSlotTime(dateStr, type, slotNumber) {
  const d = new Date(dateStr);
  const day = d.getDay();
  const endTime = (day === 5 || day === 6) ? '23:30' : '21:30';
  if (type === 'fix' && slotNumber === 1) {
    return { start: '16:15', end: endTime };
  }
  return { start: '17:15', end: endTime };
}

// Format date as "Montag, 21.04.2026"
function formatDateLong(dateStr) {
  const DAYS = ['Sonntag','Montag','Dienstag','Mittwoch','Donnerstag','Freitag','Samstag'];
  const d = new Date(dateStr);
  const dd = String(d.getDate()).padStart(2,'0');
  const mm = String(d.getMonth()+1).padStart(2,'0');
  const yyyy = d.getFullYear();
  return `${DAYS[d.getDay()]}, ${dd}.${mm}.${yyyy}`;
}

// Build ICS calendar download URL
function buildCalendarLink(name, standort, dateStr, startTime, endTime) {
  const params = new URLSearchParams({ name, standort, date: dateStr, start: startTime, end: endTime });
  return `https://schichtplan-ufys.onrender.com/kalender.ics?${params.toString()}`;
}

// Send WhatsApp message via Twilio
function sendWhatsApp(toNumber, message) {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
    console.log('[WhatsApp] Twilio not configured, skipping.');
    return;
  }

  // Normalize number: remove spaces, dashes; ensure +49 format
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

// GET ICS calendar file - opens native calendar app on any device
app.get('/kalender.ics', (req, res) => {
  const { name, standort, date, start, end } = req.query;
  if (!name || !date || !start || !end) {
    return res.status(400).send('Fehlende Parameter');
  }
  const d = new Date(date);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth()+1).padStart(2,'0');
  const dd = String(d.getDate()).padStart(2,'0');
  const dtStart = `${yyyy}${mm}${dd}T${start.replace(':','')}00`;
  const dtEnd   = `${yyyy}${mm}${dd}T${end.replace(':','')}00`;
  const standortName = standort ? standort.charAt(0).toUpperCase() + standort.slice(1) : '';

  const uid = `${dtStart}-pizzapino-${Math.random().toString(36).substr(2,9)}@pizzapino.de`;
  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Pizza Pino//Schichtplan//DE',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `DTSTART:${dtStart}`,
    `DTEND:${dtEnd}`,
    `SUMMARY:🍕 Pizza Pino ${standortName}`,
    `DESCRIPTION:Fahrerschicht – ${name}`,
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

// GET all shifts
app.get('/api/shifts', (req, res) => {
  res.json(loadData().shifts);
});

// POST register
app.post('/api/shifts/register', (req, res) => {
  const { name, standort, date, type, phone } = req.body;

  if (!name || !standort || !date || !type) {
    return res.status(400).json({ error: 'Alle Felder sind erforderlich' });
  }

  const d = new Date(date);
  if (d.getDay() === 2) {
    return res.status(400).json({ error: 'Dienstag ist Ruhetag' });
  }

  const data = loadData();

  const existing = data.shifts.find(
    s => s.name.toLowerCase() === name.toLowerCase() &&
         s.standort === standort && s.date === date && s.type === type
  );
  if (existing) {
    return res.status(409).json({ error: 'Du bist für diese Schicht bereits eingetragen' });
  }

  const shiftsForDay = data.shifts.filter(s => s.standort === standort && s.date === date);
  const fixSlots = shiftsForDay.filter(s => s.type === 'fix');
  const bereitSlots = shiftsForDay.filter(s => s.type === 'bereitschaft');
  const max = getMaxSlots(date, standort);

  if (type === 'fix' && fixSlots.length >= max.fix) {
    return res.status(409).json({ error: `Alle Fix-Plätze vergeben (max. ${max.fix})` });
  }
  if (type === 'bereitschaft' && bereitSlots.length >= max.bereit) {
    return res.status(409).json({ error: `Alle Bereitschafts-Plätze vergeben (max. ${max.bereit})` });
  }

  const slotNumber = type === 'fix' ? fixSlots.length + 1 : bereitSlots.length + 1;
  const time = getSlotTime(date, type, slotNumber);

  data.shifts.push({
    name, standort, date, type, slotNumber,
    startTime: time.start, endTime: time.end,
    phone: phone || '',
    createdAt: new Date().toISOString()
  });
  saveData(data);

  // Send WhatsApp if phone provided
  if (phone) {
    const dateLong = formatDateLong(date);
    const calLink = buildCalendarLink(name, standort, date, time.start, time.end);
    const standortName = standort.charAt(0).toUpperCase() + standort.slice(1);
    const typeLabel = type === 'fix' ? '✅ Fix-Fahrer' : '📞 Bereitschaft';

    const msg = `🍕 *Pizza Pino ${standortName}*\n\nHallo ${name}! Du bist eingetragen:\n\n📅 ${dateLong}\n⏰ ${time.start} – ${time.end} Uhr\n👤 ${typeLabel}\n\n📲 Schicht im Kalender speichern:\n${calLink}\n\n_Pizza Pino Schichtplan_`;
    sendWhatsApp(phone, msg);
  }

  res.json({
    success: true,
    message: `Erfolgreich eingetragen! Deine Schicht: ${time.start} – ${time.end} Uhr${phone ? ' – WhatsApp wird gesendet 📱' : ''}`
  });
});

// DELETE unregister
app.delete('/api/shifts/unregister', (req, res) => {
  const { name, standort, date, type } = req.body;
  const data = loadData();

  const index = data.shifts.findIndex(
    s => s.name.toLowerCase() === name.toLowerCase() &&
         s.standort === standort && s.date === date && s.type === type
  );
  if (index === -1) {
    return res.status(404).json({ error: 'Eintrag nicht gefunden' });
  }

  data.shifts.splice(index, 1);
  const remaining = data.shifts.filter(s => s.standort === standort && s.date === date && s.type === type);
  remaining.forEach((s, i) => {
    s.slotNumber = i + 1;
    const t = getSlotTime(date, type, i + 1);
    s.startTime = t.start; s.endTime = t.end;
  });

  saveData(data);
  res.json({ success: true, message: 'Erfolgreich ausgetragen!' });
});

// Admin: GET all shifts
app.get('/api/admin/shifts', (req, res) => {
  if (req.query.password !== 'pizzapino2024') {
    return res.status(401).json({ error: 'Falsches Passwort' });
  }
  res.json(loadData().shifts);
});

// Admin: DELETE by index
app.delete('/api/admin/shifts/:index', (req, res) => {
  if (req.query.password !== 'pizzapino2024') {
    return res.status(401).json({ error: 'Falsches Passwort' });
  }
  const data = loadData();
  const idx = parseInt(req.params.index);
  if (idx < 0 || idx >= data.shifts.length) {
    return res.status(404).json({ error: 'Nicht gefunden' });
  }
  const removed = data.shifts[idx];
  data.shifts.splice(idx, 1);
  const remaining = data.shifts.filter(
    s => s.standort === removed.standort && s.date === removed.date && s.type === removed.type
  );
  remaining.forEach((s, i) => {
    s.slotNumber = i + 1;
    const t = getSlotTime(removed.date, removed.type, i + 1);
    s.startTime = t.start; s.endTime = t.end;
  });
  saveData(data);
  res.json({ success: true });
});

app.listen(PORT, () => {
  console.log(`🍕 Pizza Pino Schichtplan läuft auf http://localhost:${PORT}`);
});
