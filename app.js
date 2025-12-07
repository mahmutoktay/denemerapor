// index.js
// Bot + Admin Mini Apps paneli
const TelegramBot = require('node-telegram-bot-api');
const path = require('path');
const fs = require('fs/promises');
const fssync = require('fs');
const crypto = require('crypto');
const express = require('express');
const sheetsApi = require('./googleapi');
const { buildStudentStats, getStudentReports } = require('./students');
const { listExamsWithCounts, getExamReports, deleteExamAndAssets } = require('./exams');
require('dotenv').config();




// ---- Ortam değişkenleri ----
const TOKEN = process.env.TELEGRAM_TOKEN || 'XXX'; // PROD: .env kullanın
if (!TOKEN || TOKEN === 'XXX') { console.error('TELEGRAM_TOKEN gerekli'); process.exit(1); }
// Virgülle ayrılmış admin ID’leri: ör. ALLOWED_ADMINS=12345,67890
const ALLOWED_ADMINS = (process.env.ALLOWED_ADMINS || '').split(',').map(s => s.trim()).filter(Boolean);

// ---- Bot ----
const bot = new TelegramBot(TOKEN, { polling: true });

// ---- Dizinler ve dosyalar ----
const DATA_DIR = path.join(__dirname, 'data');
const UP_DIR   = path.join(__dirname, 'uploads');
const PUB_DIR  = path.join(__dirname, 'public');
for (const d of [DATA_DIR, UP_DIR, PUB_DIR]) if (!fssync.existsSync(d)) fssync.mkdirSync(d, { recursive: true });

const EXAMS_FILE    = path.join(DATA_DIR, 'exams.json');
const REPORTS_FILE  = path.join(DATA_DIR, 'reports.json');
const STUDENTS_FILE = path.join(DATA_DIR, 'students.json'); // { [userId]: { studentNumber, fullName } }
///GÖRSEL PAYLAŞMA YARDIMCILARI
// ---- Paylaşım/OG yardımcıları ----
function absUrl(req, relPath) {
  if (!relPath) return '';
  if (/^https?:\/\//i.test(relPath)) return relPath;
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host  = req.get('host');
  return `${proto}://${host}${relPath.startsWith('/') ? relPath : '/' + relPath}`;
}
function normUpload(p) {
  if (!p) return '';
  const s = String(p).replace(/\\/g, '/');
  const i = s.lastIndexOf('/uploads/');
  if (i >= 0) return s.slice(i);           // /uploads/...
  const j = s.indexOf('uploads/');
  return j >= 0 ? '/' + s.slice(j) : s;    // uploads/...
}
function escHtml(t = '') {
  return String(t).replace(/[&<>"]/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m]));
}
//////////


// ---- JSON yardımcıları ----
async function readJson(file, fb) { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fb; } }
async function writeJson(file, data) {
  const tmp = file + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(data, null, 2));
  await fs.rename(tmp, file);
}

// ---- Başlangıç tohumları ----
(async () => {
  const exams = await readJson(EXAMS_FILE, []);
  if (exams.length === 0) {
    const now = Date.now();
    const seed = Array.from({ length: 6 }, (_, i) => ({
      id: String(now - i),
      title: `Deneme ${i + 1}`,
      createdAt: now - i * 86400000
    }));
    await writeJson(EXAMS_FILE, seed);
  }
  if (!(await readJson(REPORTS_FILE, null)))  await writeJson(REPORTS_FILE, []);
  if (!(await readJson(STUDENTS_FILE, null))) await writeJson(STUDENTS_FILE, {});
})();

// ---- Geçici state (RAM) ----
const state = new Map(); // userId(string) -> { step, examId, photoPath, candidate }
const sid   = (u) => String(u?.id ?? u);
const getS  = (u) => state.get(sid(u));
const setS  = (u, v) => state.set(sid(u), v);
const delS  = (u) => state.delete(sid(u));

// ---- Ortak yardımcılar ----
function last5(arr) { return [...arr].sort((a,b)=>b.createdAt-a.createdAt).slice(0,5); }

async function sendExamMenu(chatId){
  const exams = await readJson(EXAMS_FILE, []);
  const items = last5(exams);
  if (items.length === 0) {
    await bot.sendMessage(chatId, 'Kayıtlı sınav yok.');
    return;
  }
  const kb = { inline_keyboard: items.map(x => [{ text: x.title, callback_data: `exam:${x.id}` }]) };
  await bot.sendMessage(chatId, 'Hangi sınav hakkında rapor girmek istiyorsunuz?', { reply_markup: kb });
}

async function savePhotoByFileId(fileId) {
  return await bot.downloadFile(fileId, UP_DIR); // tam yol döner
}

// ---- Hata logları ----
bot.on('polling_error', e => console.error('polling_error:', e.code || e.message));

/* ===================== KAYIT AKIŞI (/start) ===================== */
bot.onText(/^\/start(?:@[\w_]+)?(?:\s+.*)?$/i, async (msg) => {
  const uid = sid(msg.from);
  const students = await readJson(STUDENTS_FILE, {});
  if (students[uid]) {
    await bot.sendMessage(msg.chat.id, `Zaten kayıtlısın: ${students[uid].studentNumber} • ${students[uid].fullName}`);
    return;
  }
  setS(uid, { step: 'await_number' });
  await bot.sendMessage(msg.chat.id, 'Öğrenci numaranızı giriniz.');
});

bot.on('message', async (msg) => {
  if (!msg.text || msg.text.startsWith('/')) return;
  const uid = sid(msg.from);
  const s = getS(uid);
  if (!s || s.step !== 'await_number') return;

  const stdNoRaw = msg.text.trim();
  if (!stdNoRaw) { await bot.sendMessage(msg.chat.id, 'Geçerli bir numara girin.'); return; }

  try {
    const fullName = await sheetsApi.getStudentNameByNumber(stdNoRaw); // string|null
    if (!fullName || !String(fullName).trim()) {
      await bot.sendMessage(msg.chat.id, 'Öğrenci bulunamadı. Numaranızı kontrol edip tekrar girin.');
      return;
    }
    setS(uid, { step: 'confirm_name', candidate: { studentNumber: stdNoRaw, fullName: String(fullName).trim() } });
    const kb = { inline_keyboard: [[
      { text: 'Evet', callback_data: 'confirm:yes' },
      { text: 'Hayır', callback_data: 'confirm:no' }
    ]]};
    await bot.sendMessage(msg.chat.id, `Adınız soyadınız bu mu: ${fullName}?`, { reply_markup: kb });
  } catch (e) {
    console.error('Sheets hatası:', e.message);
    await bot.sendMessage(msg.chat.id, 'Sheets erişimi hatası. Ayarları kontrol edin.');
  }
});

bot.on('callback_query', async (q) => {
  const uid = sid(q.from);
  const chatId = q.message.chat.id;

  // Kayıt onayı
  if (q.data?.startsWith('confirm:')) {
    await bot.answerCallbackQuery(q.id);
    const s = getS(uid);
    if (!s || s.step !== 'confirm_name') return;

    if (q.data === 'confirm:yes') {
      const students = await readJson(STUDENTS_FILE, {});
      const sn = String(s.candidate.studentNumber || '').trim();
      const nm = String(s.candidate.fullName || '').trim();
      if (!sn || !nm) {
        setS(uid, { step: 'await_number' });
        await bot.sendMessage(chatId, 'Öğrenci bulunamadı. Numaranızı tekrar girin.');
        return;
      }
      students[uid] = { studentNumber: sn, username: q.from.username || null, fullName: nm };
      await writeJson(STUDENTS_FILE, students);
      delS(uid);
      await bot.sendMessage(chatId, `Kayıt tamamlandı: ${sn} • ${nm}\nRapor girişi için /rapor yazın.`);
    } else {
      setS(uid, { step: 'await_number' });
      await bot.sendMessage(chatId, 'Kayıt iptal edildi. Öğrenci numaranızı tekrar giriniz.');
    }
    return;
  }

  // Rapor akışındaki sınav seçimi
  if (q.data?.startsWith('exam:')) {
    const examId = q.data.split(':')[1];
    setS(uid, { step: 'await_photo', examId });
    await bot.answerCallbackQuery(q.id);
    await bot.sendMessage(chatId, 'Lütfen sorunun fotoğrafını gönderin.');
    return;
  }
});

/* ===================== RAPOR AKIŞI (/rapor) ===================== */
bot.onText(/^\/rapor(?:@[\w_]+)?(?:\s+.*)?$/i, async (msg) => {
  const uid = sid(msg.from);
  const students = await readJson(STUDENTS_FILE, {});
  const stu = students[uid];
  if (!stu || !String(stu.studentNumber || '').trim() || !String(stu.fullName || '').trim()) {
    await bot.sendMessage(msg.chat.id, 'Öğrenci bulunamadı. Kayıt için /start yazın ve numaranızı doğrulayın.');
    return;
  }
  delS(uid);
  await bot.sendMessage(msg.chat.id, 'Öğrenci rapor girişi başlatıldı.');
  await sendExamMenu(msg.chat.id);
});

// GEÇİCİ DÜZELTME KULLANICI ADI
// ==================== /ek — Username ekleme/güncelleme ====================
bot.onText(/^\/ek(?:\s+(.+))?$/i, async (msg, match) => {
  const uid = String(msg.from.id);
  const students = await readJson(STUDENTS_FILE, {});
  const stu = students[uid];

  if (!stu) {
    await bot.sendMessage(msg.chat.id, 'Önce /start ile kayıt olun.');
    return;
  }

  // 1) Öncelik: komuttaki parametre (/ek @kadi)
  let raw = (match && match[1] || '').trim();

  // 2) Parametre yoksa: kullanıcının Telegram username’i
  if (!raw) raw = msg.from.username ? String(msg.from.username) : '';

  // normalize: baştaki @ at, sadece a-z0-9_ ve 5-32 uzunluk
  const cand = raw.replace(/^@/, '').trim();
  const valid = /^[a-zA-Z0-9_]{5,32}$/.test(cand) ? cand : '';

  if (!valid) {
    await bot.sendMessage(
      msg.chat.id,
      'Geçerli bir kullanıcı adı bulunamadı.\n' +
      'Seçenekler:\n' +
      '• Telegram ayarlarından bir kullanıcı adı belirleyin ve /ek yazın\n' +
      '• Veya /ek @kullanici_adiniz biçiminde gönderin'
    );
    return;
  }

  // Zaten aynıysa bilgi ver
  if (String(stu.username || '').toLowerCase() === valid.toLowerCase()) {
    await bot.sendMessage(msg.chat.id, `Kayıtlı kullanıcı adınız zaten @${valid}.`);
    return;
  }

  // 3) students.json güncelle
  students[uid] = { ...stu, username: valid };
  await writeJson(STUDENTS_FILE, students);

  // 4) reports.json içindeki eski kayıtları da doldur (yoksa)
  try {
    const reports = await readJson(REPORTS_FILE, []);
    let touched = 0;
    for (const r of reports) {
      if (String(r.userId) === uid && (!r.username || r.username === null)) {
        r.username = valid;
        touched++;
      }
    }
    if (touched > 0) await writeJson(REPORTS_FILE, reports);
  } catch (_) {}

  await bot.sendMessage(msg.chat.id, `Kullanıcı adınız kaydedildi: @${valid}`);
});


bot.on('photo', async (msg) => {
  const s = getS(msg.from);
  if (!s || s.step !== 'await_photo') return;

  try {
    const best = msg.photo[msg.photo.length - 1];
    const savedPath = await savePhotoByFileId(best.file_id);
    const ok = savedPath && fssync.existsSync(savedPath);
    if (!ok) throw new Error('Dosya kaydedilemedi');

    s.photoPath = savedPath;
    s.step = 'await_report';
    setS(msg.from, s);

    await bot.sendMessage(msg.chat.id, 'Teşekkürler. Şimdi soru hakkındaki raporunuzu mesaj olarak yazıp gönderin.');
  } catch (e) {
    console.error('photo err:', e);
    await bot.sendMessage(msg.chat.id, 'Fotoğraf indirilemedi. Tekrar deneyin.');
  }
});

bot.on('document', async (msg) => {
  const s = getS(msg.from);
  if (!s || s.step !== 'await_photo') return;
  if (!msg.document?.mime_type?.startsWith('image/')) return;

  try {
    const savedPath = await savePhotoByFileId(msg.document.file_id);
    const ok = savedPath && fssync.existsSync(savedPath);
    if (!ok) throw new Error('Dosya kaydedilemedi');

    s.photoPath = savedPath;
    s.step = 'await_report';
    setS(msg.from, s);

    await bot.sendMessage(msg.chat.id, 'Teşekkürler. Şimdi soru hakkındaki raporunuzu mesaj olarak yazıp gönderin.');
  } catch (e) {
    console.error('document img err:', e);
    await bot.sendMessage(msg.chat.id, 'Fotoğraf indirilemedi. Tekrar deneyin.');
  }
});

bot.on('message', async (msg) => {
  if (!msg.text || msg.text.startsWith('/')) return;
  const s = getS(msg.from);
  if (!s || s.step !== 'await_report') return;

  const exams    = await readJson(EXAMS_FILE, []);
  const reports  = await readJson(REPORTS_FILE, []);
  const students = await readJson(STUDENTS_FILE, {});
  const exam     = exams.find(e => e.id === s.examId);
  const stu      = students[sid(msg.from)] || {};

  const entry = {
    id: `${Date.now()}_${Math.random().toString(36).slice(2)}`,
    userId: sid(msg.from),
    username: msg.from.username || null,      
    studentNumber: stu.studentNumber || null,
    studentName: stu.fullName || null,
    examId: s.examId,
    examTitle: exam ? exam.title : null,
    photoPath: s.photoPath,
    reportText: msg.text.trim(),
    createdAt: Date.now()
  };
  reports.push(entry);
  await writeJson(REPORTS_FILE, reports);

  delS(msg.from);
  await bot.sendMessage(msg.chat.id, 'Raporunuz eklendi.');
});

bot.onText(/^\/iptal$/i, async (msg) => {
  delS(msg.from);
  await bot.sendMessage(msg.chat.id, 'Akış sıfırlandı.');
});

/* ===================== ADMIN PANELİ (/adminbtn) ===================== */
bot.onText(/^\/adminbtn$/i, m => {
  bot.sendMessage(m.chat.id, 'Panel', {
    reply_markup: {
      inline_keyboard: [[
        { text: 'Paneli Aç', web_app: { url: 'https://denemerapor.mahmutoktay.com/admin' } }
      ]]
    }
  });
});

/* ===================== ADMIN MINI APPS ===================== */
// Güvenli Telegram WebApp initData doğrulaması (RFC: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-apps)

function verifyInitData(initDataRaw) {
  if (!initDataRaw) return null;

  const sp = new URLSearchParams(initDataRaw);
  const hash = sp.get('hash');
  if (!hash) return null;

  // hash hariç tüm çiftleri key’e göre sırala
  const pairs = [];
  for (const [k, v] of sp.entries()) if (k !== 'hash') pairs.push(`${k}=${v}`);
  pairs.sort();
  const data_check_string = pairs.join('\n');

  // DİKKAT: key="WebAppData", message=BOT_TOKEN
  const secret_key = crypto
    .createHmac('sha256', 'WebAppData')
    .update(process.env.TELEGRAM_TOKEN) // veya TOKEN
    .digest();

  const computed = crypto
    .createHmac('sha256', secret_key)
    .update(data_check_string)
    .digest('hex');

  if (computed !== hash) return null;

  const userJson = sp.get('user');
  try { return userJson ? JSON.parse(userJson) : null; }
  catch { return null; }
}



const app = express();
app.use(express.json());
app.use('/uploads', express.static(UP_DIR)); // fotoğrafları göstermek için
// Tüm HTTP isteklerini logla
app.use((req,res,next)=>{
  //console.log('[HTTP]', req.method, req.url);
  next();
});



// ...
app.post('/api/admin/bootstrap', async (req, res) => {
  try {
    const { initData } = req.body || {};
    console.log('[BOOTSTRAP] len=', (initData||'').length);
    const user = verifyInitData(initData);
    console.log('[BOOTSTRAP] user=', user?.id || null);
    //console.log(initdata);
    if (!user) return res.status(401).json({ ok:false, error:'initData' });

    const uid = String(user.id);
    const allowed = ALLOWED_ADMINS.includes(uid);
    //console.log('ADMIN CHECK uid=', uid, 'admins=', ALLOWED_ADMINS, 'allowed=', allowed);

    if (!allowed) {
      // GEÇİCİ DEBUG: id’yi dön
      return res.status(403).json({ ok:false, error:'yetki', uid, admins: ALLOWED_ADMINS });
    }

    const exams = await readJson(EXAMS_FILE, []);
    const reports = await readJson(REPORTS_FILE, []);
    reports.sort((a,b)=>b.createdAt - a.createdAt);
    return res.json({ ok:true, user:{ id:uid, name:user.first_name||'' }, exams, reports });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok:false, error:'server' });
  }
});

//ÖĞRENCİ DUYURU BÖLÜMÜ
// Tüm öğrencilere bot üzerinden mesaj gönder
app.post('/api/admin/broadcast', async (req, res) => {
  try {
    const { initData, message } = req.body || {};
    const user = verifyInitData(initData);
    if (!user) return res.status(401).json({ ok:false, error:'initData' });

    const allowed = ALLOWED_ADMINS.includes(String(user.id));
    if (!allowed) return res.status(403).json({ ok:false, error:'yetki' });

    if (!message || !message.trim())
      return res.status(400).json({ ok:false, error:'boş mesaj' });

    const students = await readJson(STUDENTS_FILE, {});
    let sent=0, fail=0;

    for (const uid of Object.keys(students)) {
      try {
        await bot.sendMessage(uid, `📢 Yönetici duyurusu:\n\n${message}`);
        sent++;
        await new Promise(r=>setTimeout(r,400)); // flood limit
      } catch { fail++; }
    }

    return res.json({ ok:true, sent, fail });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok:false, error:'server' });
  }
});


// Sınav ekle
app.post('/api/admin/exams', async (req, res) => {
  try {
    const { initData, title } = req.body || {};
    const user = verifyInitData(initData);
    if (!user) return res.status(401).json({ ok: false, error: 'initData doğrulanamadı' });

    const isAllowed = ALLOWED_ADMINS.length === 0 || ALLOWED_ADMINS.includes(String(user.id));
    if (!isAllowed) return res.status(403).json({ ok: false, error: 'yetkiniz yok' });

    const t = String(title || '').trim();
    if (!t) return res.status(400).json({ ok: false, error: 'başlık boş' });

    const exams = await readJson(EXAMS_FILE, []);
    const newItem = { id: String(Date.now()), title: t, createdAt: Date.now() };
    exams.push(newItem);
    await writeJson(EXAMS_FILE, exams);

    return res.json({ ok: true, exam: newItem });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: 'server' });
  }
});

// Öğrenci listesi (özet)
app.post('/api/admin/students', async (req, res) => {
  try {
    const { initData } = req.body || {};
    const user = verifyInitData(initData);
    if (!user) return res.status(401).json({ ok:false, error:'initData' });

    const allowed = ALLOWED_ADMINS.includes(String(user.id));
    if (!allowed) return res.status(403).json({ ok:false, error:'yetki' });

    const stats = await buildStudentStats({
      studentsFile: STUDENTS_FILE,
      reportsFile:  REPORTS_FILE
    });

    // İsimleri göstermek için öğrenci sözlüğünü de döndürelim (detay sayfasında başlıkta lazım olabilir)
    const studentsMap = await (async () => {
      try { return JSON.parse(await fs.readFile(STUDENTS_FILE, 'utf8')); }
      catch { return {}; }
    })();

    return res.json({ ok:true, stats, students: studentsMap });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok:false, error:'server' });
  }
});

// Tek öğrencinin raporları
app.post('/api/admin/studentReports', async (req, res) => {
  try {
    const { initData, userId } = req.body || {};
    const user = verifyInitData(initData);
    if (!user) return res.status(401).json({ ok:false, error:'initData' });

    const allowed = ALLOWED_ADMINS.includes(String(user.id));
    if (!allowed) return res.status(403).json({ ok:false, error:'yetki' });

    if (!userId) return res.status(400).json({ ok:false, error:'userId required' });

    const reports = await getStudentReports({ userId, reportsFile: REPORTS_FILE });
    return res.json({ ok:true, reports });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok:false, error:'server' });
  }
});




// ... ADMIN MINI APPS bölümünde ek API'ler:

// Sınav listesi
app.post('/api/admin/exams/list', async (req, res) => {
  try {
    const { initData } = req.body || {};
    const user = verifyInitData(initData);
    if (!user) return res.status(401).json({ ok:false, error:'initData' });

    const allowed = ALLOWED_ADMINS.includes(String(user.id));
    if (!allowed) return res.status(403).json({ ok:false, error:'yetki' });

    const rows = await listExamsWithCounts({ examsFile: EXAMS_FILE, reportsFile: REPORTS_FILE });
    return res.json({ ok:true, exams: rows });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok:false, error:'server' });
  }
});

// Bir sınavın raporları
app.post('/api/admin/exams/reports', async (req, res) => {
  try {
    const { initData, examId } = req.body || {};
    const user = verifyInitData(initData);
    if (!user) return res.status(401).json({ ok:false, error:'initData' });

    const allowed = ALLOWED_ADMINS.includes(String(user.id));
    if (!allowed) return res.status(403).json({ ok:false, error:'yetki' });

    if (!examId) return res.status(400).json({ ok:false, error:'examId required' });

    const reports = await getExamReports({ examId, reportsFile: REPORTS_FILE });
    return res.json({ ok:true, reports });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok:false, error:'server' });
  }
});

// Sınavı ve tüm varlıklarını sil
app.post('/api/admin/exams/delete', async (req, res) => {
  try {
    const { initData, examId } = req.body || {};
    const user = verifyInitData(initData);
    if (!user) return res.status(401).json({ ok:false, error:'initData' });

    const allowed = ALLOWED_ADMINS.includes(String(user.id));
    if (!allowed) return res.status(403).json({ ok:false, error:'yetki' });

    if (!examId) return res.status(400).json({ ok:false, error:'examId required' });

    const result = await deleteExamAndAssets({
      examId, examsFile: EXAMS_FILE, reportsFile: REPORTS_FILE, uploadsDir: UP_DIR
    });
    return res.json({ ok:true, ...result });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok:false, error:'server' });
  }
});



// Statik rota: öğrenci listesi sayfası
app.get('/students', (_req, res) => {
  res.sendFile(path.join(PUB_DIR, 'students.html'));
});
// Admin index
app.get('/admin', (_req, res) => {
  res.sendFile(path.join(PUB_DIR, 'index.html'));
});
// Statik sayfa: sınav listesi
app.get('/exams', (_req, res) => {
  res.sendFile(path.join(PUB_DIR, 'exams.html'));
});

// ---- Paylaşım sayfası (Telegram önizleme için OG meta) ----
app.get('/share/report/:id', async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    const reports = await readJson(REPORTS_FILE, []);
    const r = reports.find(x => String(x.id) === id);
    if (!r) return res.status(404).send('Not found');

    const photoRel = normUpload(r.photoPath);
    const photoAbs = absUrl(req, photoRel);
    const title = `${r.studentName || 'Öğrenci'} — ${r.examTitle || 'Sınav'}`;
    const desc  = (r.reportText || '').slice(0, 160);

    const html = `<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8">
<title>${escHtml(title)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">

<meta property="og:type" content="article">
<meta property="og:title" content="${escHtml(title)}">
<meta property="og:description" content="${escHtml(desc)}">
<meta property="og:image" content="${escHtml(photoAbs)}">
<meta property="og:url" content="${escHtml(absUrl(req, req.originalUrl))}">
<meta name="twitter:card" content="summary_large_image">

<style>
  :root{ --bg:#0f0f13; --surface:#15151a; --text:#eaeaea; --muted:#b6b6bf; --outline:#2b2b33; }
  body{margin:0;background:var(--bg);color:var(--text);font-family:system-ui,Segoe UI,Roboto,Arial}
  .wrap{max-width:720px;margin:0 auto;padding:16px}
  .card{background:var(--surface);border:1px solid var(--outline);border-radius:14px;padding:14px;display:grid;gap:10px}
  .meta{color:var(--muted);font-size:12px}
  .title{font-weight:600}
  img{max-width:100%;height:auto;border-radius:10px;border:1px solid var(--outline)}
  .txt{white-space:pre-wrap;line-height:1.45}
</style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <div class="title">${escHtml(title)}</div>
      <div class="meta">${new Date(r.createdAt).toLocaleString('tr-TR')}</div>
      ${photoRel ? `<img src="${escHtml(photoRel)}" alt="Soru görseli">` : `<div class="meta">Fotoğraf yok</div>`}
      <div class="meta">Öğrenci raporu:</div>
      <div class="txt">${escHtml(r.reportText || '')}</div>
    </div>
  </div>
</body>
</html>`;
    res.setHeader('content-type','text/html; charset=utf-8');
    res.send(html);
  } catch (e) {
    console.error('share route err', e);
    res.status(500).send('server error');
  }
});



// Sunucu başlat
const PORT = process.env.PORT || 7445;
app.listen(PORT, () => console.log('HTTP dinleniyor:', PORT, '— Admin paneli: /admin'));
