# E-Voting HIMA

Sistem pemilihan calon wakil ketua HIMA: 2 kandidat, login pemilih dengan NIM, satu pemilih satu suara, hasil realtime di layar lain, laporan siap cetak. Dibuat untuk pemungutan suara on-site di desktop.

**Teknologi:** HTML/JS biasa (tanpa build) di Netlify, Netlify Functions (Node 18+), database Supabase (PostgreSQL).

## Fitur

- **Pemilih:** masuk dengan NIM, baca profil kedua calon (foto, nomor urut, visi, misi), konfirmasi, kirim suara. Layar kembali ke awal otomatis setelah memilih atau 2 menit tanpa aktivitas.
- **Panitia (`/admin.html`):** ringkasan live, kelola kandidat, impor daftar pemilih (tempel dari Excel atau CSV), tandai kehadiran, pengaturan jadwal, log audit, laporan.
- **Layar hasil (`/hasil.html`):** partisipasi dan perolehan suara, diperbarui tiap 3 detik. Buka di laptop atau proyektor lain.
- **Jadwal:** pemungutan suara dibuka dan ditutup otomatis sesuai waktu (WIB). Ada tombol darurat untuk menghentikan sementara.
- **Laporan:** berita acara siap cetak atau simpan PDF, unduh hasil dan daftar pemilih (CSV).

## Keamanan dan kerahasiaan suara

- Tabel `votes` hanya berisi ID kandidat. Tidak ada kolom pemilih maupun waktu, sehingga pilihan tidak tertaut ke orangnya. Log audit mencatat *siapa* sudah memilih, tidak pernah *apa* pilihannya.
- Pencatatan suara berjalan dalam satu transaksi database (`cast_vote`): cek jadwal, kunci baris pemilih, simpan suara, tandai sudah memilih. Dua permintaan serentak dari satu pemilih hanya menghasilkan satu suara.
- Suara tidak bisa diubah (trigger di database). Hanya bisa dikosongkan lewat Reset, yang ditolak saat pemungutan suara dibuka.
- Semua tabel dilindungi RLS; hanya Netlify Functions (kunci `service_role`) yang bisa mengakses data.
- Perolehan suara hanya terlihat panitia yang login, kecuali opsi "tampilkan tanpa login" dinyalakan.

**Batasan yang perlu Anda tahu:**

1. **Login hanya dengan NIM.** Siapa pun yang tahu NIM dan alamat situs bisa memilih atas nama orang lain. Karena itu nyalakan **"Pemilih harus ditandai hadir oleh panitia"** (Pengaturan). Panitia mencocokkan identitas di meja pendaftaran, lalu mencentang kolom Hadir di tab Pemilih, baru pemilih bisa masuk di bilik.
2. **Anonimitas setingkat HIMA, bukan setingkat negara.** Orang yang memegang akses penuh ke database Supabase secara teori bisa mencocokkan urutan waktu pemilih dengan urutan suara. Batasi siapa yang punya akses ke dashboard Supabase.
3. **Penguncian percobaan gagal.** Login panitia terkunci 10 menit setelah 5 kali salah, dan login pemilih setelah 30 NIM tidak dikenal dalam 10 menit. Ini melindungi dari tebakan, tetapi pihak luar yang mengetahui alamat situs bisa sengaja memicunya. Jangan sebarkan alamat situs sebelum hari-H.
4. Simpan `SUPABASE_SERVICE_KEY` dan `ADMIN_PASSWORD` hanya di Netlify. Jangan pernah dimasukkan ke repositori.

## Cara deploy

### 1. Supabase

1. Buat project di [supabase.com](https://supabase.com).
2. Buka **SQL Editor**, tempel seluruh isi `supabase/schema.sql`, jalankan. Aman dijalankan ulang.
3. Dari **Project Settings → API** salin `Project URL` dan kunci `service_role`.

### 2. Netlify

1. Unggah folder ini ke repositori GitHub (file `.gitignore` sudah menyiapkan agar `.env` tidak ikut).
2. Di Netlify: **Add new site → Import from Git**, pilih repositori. Pengaturan build sudah ada di `netlify.toml` (publish `public`, functions `netlify/functions`).
3. Di **Site configuration → Environment variables** isi:

| Variabel | Isi |
|---|---|
| `SUPABASE_URL` | Project URL dari Supabase |
| `SUPABASE_SERVICE_KEY` | kunci `service_role` |
| `ADMIN_PASSWORD` | kata sandi panitia, panjang dan unik |
| `TOKEN_SECRET` | acak minimal 32 karakter: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |

4. Deploy ulang setelah variabel diisi.

### Uji lokal (opsional)

Salin `.env.example` ke `.env`, isi nilainya, lalu `npm install` dan `npx netlify dev`.

## Persiapan sebelum hari-H

1. Login di `/admin.html`. Isi **Kandidat** (nomor urut, nama, foto, visi, misi).
2. Isi **Pemilih**: tempel daftar `NIM, Nama` dari Excel.
3. Di **Pengaturan**: isi nama pemilihan dan jadwal, nyalakan "Pemilih harus ditandai hadir".
4. **Uji coba** dengan beberapa NIM, cek hasil di layar hasil dan Laporan.
5. Hentikan pemungutan suara (Pengaturan), lalu **Reset suara** untuk membuang data uji coba. Matikan lagi opsi hentikan.
6. Siapkan laptop bilik, buka halaman utama (`/`). Siapkan layar hasil di perangkat lain: `/hasil.html`.
7. Supabase paket gratis menjeda project yang tidak aktif sekitar satu minggu. Buka dashboard dan pastikan project aktif beberapa hari sebelum hari-H.

## Saat pemungutan suara

- Pemilih datang, panitia mencocokkan identitas, mencentang **Hadir** di tab Pemilih.
- Pemilih memasukkan NIM di bilik dan memilih. Layar kembali ke awal sendiri.
- Pantau partisipasi di tab Ringkasan. Jika ada masalah: **Pengaturan → Hentikan pemungutan suara sekarang**.

## Setelah ditutup

Buka tab **Laporan**: cetak atau simpan berita acara sebagai PDF, minta tanda tangan ketua panitia dan saksi, unduh CSV. Jika jumlah suara berbeda dengan jumlah pemilih yang tercatat memilih, laporan menampilkan peringatan; periksa Log audit sebelum menetapkan hasil.

## Struktur

```
public/               halaman statis
  index.html          bilik pemilih
  admin.html          panel panitia
  hasil.html          layar hasil realtime
  assets/             JS dan CSS
netlify/functions/    API: election, voter-login, vote, live, admin-login, admin
netlify/lib/common.js token HMAC, status jadwal, utilitas
supabase/schema.sql   tabel, fungsi cast_vote, RLS
```
