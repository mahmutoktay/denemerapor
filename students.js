// students.js
const fs = require('fs/promises');

async function readJson(file, fb) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch { return fb; }
}

/**
 * Tüm kayıtlı öğrencileri döndürür.
 * Raporu yoksa reportCount=0, lastReportAt=null olur.
 */
async function buildStudentStats({ studentsFile, reportsFile }) {
  const studentsMap = await readJson(studentsFile, {}); // { userId: {...} }
  const reports = await readJson(reportsFile, []);

  // Raporları kullanıcıya göre grupla
  const agg = {};
  for (const r of reports) {
    const uid = String(r.userId);
    if (!agg[uid]) agg[uid] = { count: 0, lastAt: 0 };
    agg[uid].count++;
    if (r.createdAt > agg[uid].lastAt) agg[uid].lastAt = r.createdAt;
  }

  // Öğrenciler listesi
  const out = [];
  for (const [uid, s] of Object.entries(studentsMap)) {
    const a = agg[uid] || { count: 0, lastAt: 0 };
    out.push({
      userId: uid,
      studentNumber: s.studentNumber || null,
      studentName: s.fullName || '(adsız)',
      reportCount: a.count,
      lastReportAt: a.lastAt || null,
    });
  }

  // Son rapor tarihi varsa ona göre sırala, yoksa en alta
  out.sort((a,b)=>{
    if (!a.lastReportAt && !b.lastReportAt) return 0;
    if (!a.lastReportAt) return 1;
    if (!b.lastReportAt) return -1;
    return b.lastReportAt - a.lastReportAt;
  });

  return out;
}

/** Tek öğrencinin raporlarını döndürür (yeni → eski) */
async function getStudentReports({ userId, reportsFile }) {
  const reports = await readJson(reportsFile, []);
  const uid = String(userId);
  return reports
    .filter(r => String(r.userId) === uid)
    .sort((a,b) => b.createdAt - a.createdAt);
}

module.exports = { buildStudentStats, getStudentReports };
