// googleapis.js
const { google } = require('googleapis');
const path = require('path');

// --- Yapılandırma Bilgileri ---

// 1. JSON Anahtar dosyanızın yolu
const KEYFILEPATH = path.join(__dirname, 'ogrencibilgisheets_api.json');

// 2. Google E-Tablonuzun ID'si (URL'den alın)
const SPREADSHEET_ID = '1JMBQJiuJaWuAhsUINUjxdpXi1BH_-_9LVnGjF7XZxNI'; // <-- Kendi ID'niz ile değiştirin

// Okunacak veri aralığı: Öğrenci Numarası (A), Ad (C) ve Soyadı (D) sütunlarını içerir.
// Tüm satırları okumak için satır aralığı vermeyin. Örn: 'Sayfa1!A:D'
const RANGE = 'liste!A:D'; // <-- Sayfa adını kontrol edin

/**
 * Google Sheets API'ye kimlik doğrulaması yaparak E-Tablo verilerini okur
 * ve öğrenci numarasına göre eşleştirme yapar.
 *
 * @param {string} studentNumber Aranacak öğrenci numarası.
 * @returns {Promise<string>} Öğrencinin adı ve soyadı veya hata mesajı.
 */
async function getStudentNameByNumber(studentNumber) {
    try {
        // 1. Kimlik Doğrulama
        const auth = new google.auth.GoogleAuth({
            keyFile: KEYFILEPATH,
            scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'], 
        });
        const client = await auth.getClient();
        const sheets = google.sheets({ version: 'v4', auth: client });

        // 2. API isteğiyle tüm verileri al
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: RANGE,
        });

        const rows = response.data.values;

        if (!rows || rows.length === 0) {
            return 'E-Tabloda veri bulunamadı.';
        }

        // 3. Verileri İşleme ve Eşleştirme
        // Not: Sheets API'den gelen veriler, 0'dan başlayan dizin (index) kullanır.
        // A Sütunu = 0. index (Öğrenci Numarası)
        // C Sütunu = 2. index (Ad)
        // D Sütunu = 3. index (Soyad)

        // trim() kullanarak boşlukları temizleyerek eşleştirme yapıyoruz.
        const studentRow = rows.find(row => 
            row[0] && row[0].toString().trim() === studentNumber.toString().trim()
        );

        if (studentRow) {
            const firstName = studentRow[2] || ''; // C sütunu (2. index)
            const lastName = studentRow[3] || '';  // D sütunu (3. index)
            
            // Ad ve Soyadı aralarında bir boşlukla birleştir
            return `${firstName} ${lastName}`.trim();
        } else {
            return ``;
        }
        
    } catch (error) {
        console.error('API veya işleme hatası:', error.message);
        return 'Veri alınırken beklenmeyen bir hata oluştu.';
    }
}

module.exports = {
    getStudentNameByNumber
};