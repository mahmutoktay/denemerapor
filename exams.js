// exams.js
const fs = require('fs/promises');
const fssync = require('fs');
const path = require('path');

async function readJson(file, fb) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch { return fb; }
}
async function writeJson(file, data) {
  const tmp = file + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(data, null, 2));
  await fs.rename(tmp, file);
}

/**
 * Sınav listesi + rapor sayısı.
 * Çıktı: [{ id, title, createdAt, reportCount, lastReportAt }]
 */
async function listExamsWithCounts({ examsFile, reportsFile }) {
  const exams = await readJson(examsFile, []);
  const reports = await readJson(reportsFile, []);

  const countByExam = new Map(); // examId -> {count, lastAt}
  for (const r of reports) {
    const e = String(r.examId || '');
    if (!e) continue;
    const cur = countByExam.get(e) || { count: 0, lastAt: 0 };
    cur.count += 1;
    cur.lastAt = Math.max(cur.lastAt, Number(r.createdAt || 0));
    countByExam.set(e, cur);
  }

  const out = exams.map(x => {
    const c = countByExam.get(String(x.id)) || { count: 0, lastAt: 0 };
    return {
      id: String(x.id),
      title: x.title,
      createdAt: Number(x.createdAt || 0),
      reportCount: c.count,
      lastReportAt: c.lastAt || null,
    };
  });

  // En son eklenen sınav en üstte
  out.sort((a,b)=> b.createdAt - a.createdAt);
  return out;
}

/** Belirli sınavın raporları (yeni -> eski) */
async function getExamReports({ examId, reportsFile }) {
  const reports = await readJson(reportsFile, []);
  const id = String(examId);
  return reports
    .filter(r => String(r.examId) === id)
    .sort((a,b)=> b.createdAt - a.createdAt);
}

/**
 * Sınavı ve ilişkili tüm verileri sil:
 * - reports.json’dan bu sınava ait raporları çıkar
 * - uploads altındaki fotoğrafları sil
 * - exams.json’dan sınavı sil
 */
async function deleteExamAndAssets({ examId, examsFile, reportsFile, uploadsDir }) {
  const id = String(examId);

  const exams = await readJson(examsFile, []);
  const reports = await readJson(reportsFile, []);

  const keepReports = [];
  for (const r of reports) {
    if (String(r.examId) !== id) { keepReports.push(r); continue; }
    const p = r.photoPath;
    if (p && fssync.existsSync(p)) {
      try { await fs.unlink(p); } catch { /* yoksay */ }
    }
  }

  const newExams = exams.filter(e => String(e.id) !== id);

  await writeJson(reportsFile, keepReports);
  await writeJson(examsFile, newExams);

  return { removedReports: reports.length - keepReports.length, removedExam: exams.length - newExams.length };
}

module.exports = { listExamsWithCounts, getExamReports, deleteExamAndAssets };
