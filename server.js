const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');

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
  const day = d.getDay(); // 0=Sun,1=Mon,...6=Sat
  const extraFix = standort === 'esslingen' ? 1 : 0;
  if (day === 5 || day === 6 || day === 0) {
    return { fix: 2 + extraFix, bereit: 1 };
  }
  return { fix: 1 + extraFix, bereit: 1 };
}

// Shift time based on slot position:
// fix slot 1 → 16:15 Uhr
// fix slot 2+, bereitschaft → 17:15 Uhr
// End times: Mo-Do 21:30, Fr-Sa-So 23:30
function getSlotTime(dateStr, type, slotNumber) {
  const d = new Date(dateStr);
  const day = d.getDay();
  const endTime = (day === 5 || day === 6) ? '23:30' : '21:30';
  if (type === 'fix' && slotNumber === 1) {
    return { start: '16:15', end: endTime };
  }
  return { start: '17:15', end: endTime };
}

// GET all shifts
app.get('/api/shifts', (req, res) => {
  const data = loadData();
  res.json(data.shifts);
});

// POST register
app.post('/api/shifts/register', (req, res) => {
  const { name, standort, date, type } = req.body;

  if (!name || !standort || !date || !type) {
    return res.status(400).json({ error: 'Alle Felder sind erforderlich' });
  }

  const d = new Date(date);
  if (d.getDay() === 2) {
    return res.status(400).json({ error: 'Dienstag ist Ruhetag' });
  }

  const data = loadData();

  // Duplicate check
  const existing = data.shifts.find(
    s => s.name.toLowerCase() === name.toLowerCase() &&
         s.standort === standort &&
         s.date === date &&
         s.type === type
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

  // Determine slot number (1-based within type)
  const slotNumber = type === 'fix' ? fixSlots.length + 1 : bereitSlots.length + 1;
  const time = getSlotTime(date, type, slotNumber);

  data.shifts.push({
    name,
    standort,
    date,
    type,
    slotNumber,
    startTime: time.start,
    endTime: time.end,
    createdAt: new Date().toISOString()
  });
  saveData(data);

  res.json({ success: true, message: `Erfolgreich eingetragen! Deine Schicht: ${time.start} – ${time.end} Uhr` });
});

// DELETE unregister
app.delete('/api/shifts/unregister', (req, res) => {
  const { name, standort, date, type } = req.body;
  const data = loadData();

  const index = data.shifts.findIndex(
    s => s.name.toLowerCase() === name.toLowerCase() &&
         s.standort === standort &&
         s.date === date &&
         s.type === type
  );

  if (index === -1) {
    return res.status(404).json({ error: 'Eintrag nicht gefunden' });
  }

  data.shifts.splice(index, 1);

  // Recalculate slot numbers for remaining entries of same day/standort/type
  const remaining = data.shifts.filter(s => s.standort === standort && s.date === date && s.type === type);
  remaining.forEach((s, i) => {
    s.slotNumber = i + 1;
    const t = getSlotTime(date, type, i + 1);
    s.startTime = t.start;
    s.endTime = t.end;
  });

  saveData(data);
  res.json({ success: true, message: 'Erfolgreich ausgetragen!' });
});

// Admin: GET all shifts
app.get('/api/admin/shifts', (req, res) => {
  const { password } = req.query;
  if (password !== 'pizzapino2024') {
    return res.status(401).json({ error: 'Falsches Passwort' });
  }
  res.json(loadData().shifts);
});

// Admin: DELETE by index
app.delete('/api/admin/shifts/:index', (req, res) => {
  const { password } = req.query;
  if (password !== 'pizzapino2024') {
    return res.status(401).json({ error: 'Falsches Passwort' });
  }
  const data = loadData();
  const idx = parseInt(req.params.index);
  if (idx < 0 || idx >= data.shifts.length) {
    return res.status(404).json({ error: 'Nicht gefunden' });
  }

  const removed = data.shifts[idx];
  data.shifts.splice(idx, 1);

  // Recalculate slots
  const remaining = data.shifts.filter(
    s => s.standort === removed.standort && s.date === removed.date && s.type === removed.type
  );
  remaining.forEach((s, i) => {
    s.slotNumber = i + 1;
    const t = getSlotTime(removed.date, removed.type, i + 1);
    s.startTime = t.start;
    s.endTime = t.end;
  });

  saveData(data);
  res.json({ success: true });
});

app.listen(PORT, () => {
  console.log(`🍕 Pizza Pino Schichtplan läuft auf http://localhost:${PORT}`);
});
