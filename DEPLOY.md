# 🎯 마추기온라인.io — 배포 가이드

## 📁 프로젝트 구조

```
matchu-online/
├── server/
│   └── index.js          ← 백엔드 서버 (Express + Socket.IO)
├── public/
│   └── index.html        ← 프론트엔드 (전체 UI)
├── package.json
├── Dockerfile
├── .gitignore
└── DEPLOY.md             ← 이 파일
```

---

## 🖥️ 1단계: 로컬에서 테스트하기

### 필수 조건
- Node.js 18 이상 설치 (https://nodejs.org)

### 실행 방법
```bash
# 프로젝트 폴더로 이동
cd matchu-online

# 패키지 설치
npm install

# 서버 실행
npm start
```

브라우저에서 `http://localhost:3000` 접속하면 게임이 실행됩니다!

> 💡 같은 와이파이에 있는 친구들은 `http://[내 IP]:3000`으로 접속 가능

---

## 🌐 2단계: 무료로 인터넷에 배포하기

### 옵션 A: Render (추천 — 가장 쉬움)

1. **GitHub에 코드 올리기**
   ```bash
   git init
   git add .
   git commit -m "마추기온라인 v1.0"
   
   # GitHub에서 새 저장소 만든 후:
   git remote add origin https://github.com/[내계정]/matchu-online.git
   git branch -M main
   git push -u origin main
   ```

2. **Render 가입 & 배포**
   - https://render.com 에 가입 (GitHub 연동)
   - "New" → "Web Service" 클릭
   - GitHub 저장소 선택
   - 설정:
     - **Name**: `matchu-online`
     - **Runtime**: `Node`
     - **Build Command**: `npm install`
     - **Start Command**: `npm start`
     - **Plan**: Free
   - "Create Web Service" 클릭

3. **완료!**
   - `https://matchu-online.onrender.com` 형태의 URL이 생성됨
   - 무료 플랜은 15분 비활동 시 슬립 → 첫 접속 시 30초 정도 대기

---

### 옵션 B: Railway

1. https://railway.app 가입
2. "New Project" → "Deploy from GitHub repo"
3. 저장소 선택 → 자동으로 감지 & 배포
4. Settings에서 포트 설정: `PORT=3000`
5. 무료 크레딧 $5/월 제공

---

### 옵션 C: Fly.io

1. Fly CLI 설치:
   ```bash
   curl -L https://fly.io/install.sh | sh
   ```

2. 배포:
   ```bash
   fly auth login
   fly launch --name matchu-online
   fly deploy
   ```

3. `https://matchu-online.fly.dev` 로 접속 가능

---

### 옵션 D: VPS (유료 — 안정적)

DigitalOcean, Vultr, AWS Lightsail 등에서 $5/월 서버:

```bash
# 서버에 SSH 접속 후
sudo apt update && sudo apt install -y nodejs npm git

# 코드 받기
git clone https://github.com/[내계정]/matchu-online.git
cd matchu-online
npm install

# PM2로 영구 실행
npm install -g pm2
pm2 start server/index.js --name matchu-online
pm2 save
pm2 startup
```

---

## 🌍 3단계: 커스텀 도메인 연결 (선택)

### .io 도메인 구매
- https://www.namecheap.com 또는 https://www.godaddy.com
- `마추기온라인.io` 또는 `matchu.io` 검색 & 구매
- .io 도메인은 보통 $30~50/년

### DNS 설정
1. 도메인 관리 페이지에서 DNS 레코드 추가
2. Render 사용 시:
   - CNAME 레코드: `@` → `matchu-online.onrender.com`
   - Render 대시보드 → Settings → Custom Domain에 도메인 추가
3. VPS 사용 시:
   - A 레코드: `@` → 서버 IP 주소

### SSL (HTTPS) 설정
- Render, Railway, Fly.io는 **자동으로 SSL 인증서 적용**
- VPS의 경우:
  ```bash
  sudo apt install certbot
  sudo certbot --standalone -d matchu.io
  ```

---

## 🔧 4단계: 프로덕션 개선사항

### 데이터 영구 저장 (현재는 메모리)
```bash
# MongoDB 사용 시
npm install mongoose

# 또는 Redis 사용
npm install redis
```

### 환경 변수
```bash
# .env 파일 생성
PORT=3000
NODE_ENV=production
DATABASE_URL=mongodb://...
```

### 미디어 파일 (음악/영상)
- YouTube 임베드 또는 외부 링크 사용
- 직접 호스팅: AWS S3 또는 Cloudflare R2 (무료 10GB)
- 맵 제작 시 YouTube URL을 입력받아 iframe으로 재생

### 보안
```bash
# 프로덕션 필수 패키지
npm install helmet cors rate-limiter-flexible
```

### Nginx 리버스 프록시 (VPS)
```nginx
server {
    listen 80;
    server_name matchu.io;
    
    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
}
```

---

## 🚀 빠른 배포 요약

| 단계 | 할 일 | 소요 시간 |
|------|--------|-----------|
| 1 | 로컬 테스트 (`npm install && npm start`) | 2분 |
| 2 | GitHub에 push | 5분 |
| 3 | Render에서 배포 | 5분 |
| 4 | (선택) 도메인 구매 & 연결 | 30분 |

**총 12분이면 전 세계에서 접속 가능한 퀴즈 게임 완성!** 🎉

---

## ❓ 자주 묻는 질문

**Q: 무료로 배포할 수 있나요?**
A: 네! Render 무료 플랜으로 충분합니다. 다만 비활동 시 슬립 모드.

**Q: 동시 접속자 몇 명까지 가능한가요?**
A: 무료 플랜 기준 약 50~100명. 유료 플랜이나 VPS면 수천 명 가능.

**Q: 게임 데이터가 날아가나요?**
A: 현재 메모리 저장이라 서버 재시작 시 초기화됩니다. MongoDB 연동하면 영구 저장!

**Q: 음악/영상은 어떻게 추가하나요?**
A: YouTube URL을 맵 제작 시 입력하면 됩니다. 서버에 `mediaUrl` 필드 추가 완료.
