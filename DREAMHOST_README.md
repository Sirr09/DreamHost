# DreamHost Deployment Guide

Bu layihə DreamHost VPS və ya Shared Hosting (Node.js dəstəyi ilə) üzərində işləmək üçün optimallaşdırılıb.

## 1. Hazırlıq
DreamHost panelindən Node.js dəstəyini aktiv edin və terminal vasitəsilə serverə qoşulun.

## 2. Faylların Upload Edilməsi
Layihə qovluğunu (server və client daxil olmaqla) serverə yükləyin.

## 3. Quraşdırma
Terminalda layihə qovluğuna keçid edin və aşağıdakı komandaları icra edin:

```bash
# Server asılılıqlarını yükləyin
cd server
npm install

# .env faylını hazırlayın
cp .env.example .env
# .env daxilindəki məlumatları (JWT_SECRET və s.) dəyişdirin

# Database-i və Admin-i hazırlayın
npm run seed
```

## 4. Frontend Build (Lokalda və ya Serverdə)
Frontend-i build edib serverin `public` qovluğuna göndərmək lazımdır:

```bash
cd ../client
npm install
npm run build
```

Build bitdikdən sonra fayllar `server/public` qovluğunda olacaq.

## 5. Launch
Serveri işə salmaq üçün:

```bash
cd ../server
npm start
```

Production üçün `pm2` istifadə etməyiniz tövsiyə olunur:
```bash
npm install -g pm2
pm2 start server.js --name dreamhost-app
```

## 6. Default Admin
Email: `admin@dreamhost.az`
Password: `DreamHost@2026!`
(Production-da dərhal dəyişdirilməlidir!)

## 7. Qeydlər
- **SQLite**: Database faylı `server/data/dreamhost.sqlite` yolunda yaranacaq. Hər hansı xarici SQL serverə ehtiyac yoxdur.
- **Serving**: Node app həm API-ni, həm də React frontend-i eyni portda servis edir.
