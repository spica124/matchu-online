// ═══════════════════════════════════════════════════════════════
// 마추기온라인.io — Server (Express + Socket.IO + MongoDB + Auth)
// ═══════════════════════════════════════════════════════════════

require("dotenv").config();
const express    = require("express");
const http       = require("http");
const { Server } = require("socket.io");
const path       = require("path");
const cookieParser = require("cookie-parser");
const { v4: uuidv4 } = require("uuid");
const mongoose  = require("mongoose");
const bcrypt    = require("bcryptjs");
const jwt       = require("jsonwebtoken");
const helmet    = require("helmet");

const app    = express();
const server = http.createServer(app);

// ── 프록시 신뢰 (Render·Railway·Fly.io 등 리버스 프록시 뒤에서 실제 IP 사용) ──
app.set("trust proxy", 1);

// ── 환경 변수 검증 (서버 시작 시) ──
const JWT_SECRET     = process.env.JWT_SECRET;
const MONGODB_URI    = process.env.MONGODB_URI || "mongodb://localhost:27017/matchu-online";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "http://localhost:3000";
const IS_PROD        = process.env.NODE_ENV === "production";
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "";

if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error("❌ JWT_SECRET이 설정되지 않았거나 너무 짧습니다 (32자 이상 필요). .env 파일을 확인하세요.");
  process.exit(1);
}

// ── 7. Helmet — XSS·Clickjacking 등 보안 헤더 ──
app.use(helmet({
  contentSecurityPolicy: false, // CSP는 인라인 스크립트가 많아 별도 설정 필요 시 활성화
  crossOriginEmbedderPolicy: false, // YouTube iframe 허용
}));

const io = new Server(server, {
  cors: { origin: ALLOWED_ORIGIN, methods: ["GET", "POST"], credentials: true },
  pingTimeout: 60000, pingInterval: 25000,
});

// ── 11. express.json() payload 크기 제한 1MB ──
app.use(express.static(path.join(__dirname, "../public")));
app.use(express.json({ limit: "1mb" }));
// ── 15. 쿠키 파서 (HttpOnly JWT 쿠키용) ──
app.use(cookieParser());

// ── 방 생성 레이트 리밋 (in-memory) ──
const _roomCreateLog = new Map(); // userId → timestamp[]

// ── 8. 로그인 브루트포스 방지 (IP당 1분 10회) ──
const _loginAttempts = new Map(); // ip → { count, resetAt }

function checkLoginRateLimit(ip) {
  const now = Date.now();
  let entry = _loginAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + 60_000 };
    _loginAttempts.set(ip, entry);
  }
  entry.count++;
  return entry.count <= 10; // 10회 초과 시 false
}

// ── in-memory Map 주기적 정리 (메모리 누수 방지) ──
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of _loginAttempts) {
    if (now > entry.resetAt) _loginAttempts.delete(ip);
  }
  for (const [uid, timestamps] of _roomCreateLog) {
    const recent = timestamps.filter(t => now - t < 60_000);
    if (recent.length === 0) _roomCreateLog.delete(uid);
    else _roomCreateLog.set(uid, recent);
  }
}, 5 * 60_000); // 5분마다

// ── 채팅 레이트 리밋 ──
// user 객체에 _lastChat 필드 사용

// ═══════════════════════════════════════════
// MongoDB
// ═══════════════════════════════════════════

// ── 12. MongoDB 연결 실패 시 서버 종료 ──
mongoose.connect(MONGODB_URI)
  .then(() => console.log("✅ MongoDB 연결 성공"))
  .catch(e  => { console.error("❌ MongoDB 연결 실패:", e.message); process.exit(1); });

// ── Schemas ──

const userSchema = new mongoose.Schema({
  username:  { type: String, required: true, unique: true, trim: true },
  password:  { type: String, required: true },
  avatar:    { type: String, default: "🦊" },
  favorites: { type: [String], default: [] },  // mapId[]
  createdAt: { type: Date, default: Date.now },
});
const UserModel = mongoose.model("User", userSchema);

const subQSchema = new mongoose.Schema({
  prompt:         { type: String, default: "" },
  answers:        { type: [String], default: [] },
  timeLimit:      { type: Number, default: 30 },
  chosungHint:    { type: Boolean, default: false },
  hintRevealTime: { type: Number, default: 0 },
  showAnswer:     { type: Boolean, default: true },
}, { _id: false });

const questionSchema = new mongoose.Schema({
  id:             Number,
  type:           { type: String, default: "audio" },
  hint:           { type: String, default: "" },
  answers:        { type: [String], default: [] },
  anime:          { type: String, default: "" },
  timeLimit:      { type: Number, default: 30 },
  mediaUrl:       { type: String, default: "" },
  startTime:      { type: Number, default: 0 },
  endTime:        { type: Number, default: 0 },
  volume:         { type: Number, default: 100 },
  chosungHint:    { type: Boolean, default: false },
  hintRevealTime: { type: Number, default: 0 },
  subQuestions:   { type: [subQSchema], default: [] },
}, { _id: false });

const mapSchema = new mongoose.Schema({
  mapId:     { type: String, required: true, unique: true, index: true },
  name:      { type: String, required: true },
  author:    { type: String, default: "익명" },
  authorId:  { type: String, default: "" },   // User._id
  icon:      { type: String, default: "🎵" },
  category:  { type: String, default: "anime-song" },
  tags:      { type: [String], default: [] },
  plays:          { type: Number, default: 0 },
  rating:         { type: Number, default: 0 },
  favoritesCount: { type: Number, default: 0 },
  status:         { type: String, enum: ["draft","pending","approved","rejected"], default: "draft", index: true },
  rejectReason:   { type: String, default: "" },
  submittedAt:    { type: Date },
  approvedAt:     { type: Date },
  questions: { type: [questionSchema], default: [] },
  createdAt: { type: Date, default: Date.now },
});
const MapModel = mongoose.model("Map", mapSchema);

const rankingSchema = new mongoose.Schema({
  userId: String,   // 유저 고유 ID (없으면 name 기반)
  name: String, avatar: String, score: Number,
  mapId: String, mapName: String,
  date: { type: Date, default: Date.now },
});
// 유저 + 맵 조합은 유일 (최고점수 1건만 유지)
rankingSchema.index({ userId: 1, mapId: 1 }, { unique: true, sparse: true });
const RankingModel = mongoose.model("Ranking", rankingSchema);

// ═══════════════════════════════════════════
// In-Memory
// ═══════════════════════════════════════════

const users = new Map();  // socketId → { id, name, avatar, score }
const rooms = new Map();  // roomId   → Room
let onlineCount = 0;

// ═══════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════

// 모든 플레이어가 스킵 투표 OR 모든 소문제 완료 → 다음 문제
function allPlayersDoneOrSkipped(room, subQs) {
  for (const [sid, p] of room.players) {
    if (room.skipVoters.has(sid)) continue;
    if (subQs.every((_, i) => p.answeredSubQs.has(i))) continue;
    return false;
  }
  return true;
}

function hasKorean(str) { return /[가-힣ㄱ-ㅎㅏ-ㅣ]/.test(str); }

function getChosung(str) {
  const CS = ['ㄱ','ㄲ','ㄴ','ㄷ','ㄸ','ㄹ','ㅁ','ㅂ','ㅃ','ㅅ','ㅆ','ㅇ','ㅈ','ㅉ','ㅊ','ㅋ','ㅌ','ㅍ','ㅎ'];
  return str.split('').map(ch => {
    const code = ch.charCodeAt(0) - 0xAC00;
    if (code >= 0 && code <= 11171) return CS[Math.floor(code / 588)];
    return ch === ' ' ? ' ' : ch;
  }).join('');
}

function getSubQuestions(q) {
  if (q.subQuestions && q.subQuestions.length > 0) return q.subQuestions;
  return [{ prompt: q.hint || "", answers: q.answers || [], timeLimit: q.timeLimit || 30, chosungHint: q.chosungHint || false, hintRevealTime: q.hintRevealTime || 0 }];
}

function normalizeQuestions(questions) {
  return questions.map((q, i) => {
    let subQuestions = [];
    if (Array.isArray(q.subQuestions) && q.subQuestions.length > 0) {
      subQuestions = q.subQuestions.map(sq => {
        let ans = Array.isArray(sq.answers)
          ? sq.answers.map(a => a.toLowerCase().trim()).filter(Boolean)
          : (sq.answers || "").split(",").map(a => a.toLowerCase().trim()).filter(Boolean);
        if (!ans.length) ans = [""];
        return { prompt: sq.prompt || "", answers: ans, timeLimit: parseInt(sq.timeLimit) || 30, chosungHint: !!sq.chosungHint, hintRevealTime: parseInt(sq.hintRevealTime) || 0, showAnswer: sq.showAnswer !== false };
      });
    }
    let answers = Array.isArray(q.answers)
      ? q.answers.map(a => a.toLowerCase().trim()).filter(Boolean)
      : (q.answers || q.answer || "").split(",").map(a => a.toLowerCase().trim()).filter(Boolean);
    if (!answers.length) answers = [""];
    return {
      id: i + 1, type: q.type || "audio", hint: q.hint || "", answers, anime: q.anime || "",
      timeLimit: q.timeLimit || 30, mediaUrl: q.mediaUrl || "",
      startTime: parseInt(q.startTime) || 0, endTime: parseInt(q.endTime) || 0,
      volume: (q.volume !== undefined && q.volume !== null) ? Math.min(100, Math.max(0, parseInt(q.volume))) : 100,
      chosungHint: !!q.chosungHint, hintRevealTime: parseInt(q.hintRevealTime) || 0, subQuestions,
    };
  });
}

// ── 15. HttpOnly 쿠키 설정 헬퍼 ──
const COOKIE_OPTS = {
  httpOnly: true,         // JS에서 접근 불가 (XSS 방어)
  secure: IS_PROD,        // 프로덕션에서만 HTTPS 필수
  sameSite: "lax",
  maxAge: 7 * 24 * 60 * 60 * 1000, // 7일
};

function setTokenCookie(res, token) {
  res.cookie("authToken", token, COOKIE_OPTS);
}

function clearTokenCookie(res) {
  res.clearCookie("authToken", { httpOnly: true, secure: IS_PROD, sameSite: "lax" });
}

// ── Auth Middleware — 쿠키 우선, Authorization 헤더 fallback ──
function authMiddleware(req, res, next) {
  const token = req.cookies?.authToken || req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "로그인이 필요합니다" });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch { res.status(401).json({ error: "토큰이 유효하지 않습니다" }); }
}

// ── 디스코드 웹훅 ──
async function sendDiscordMapSubmitted(map) {
  const webhookUrl = process.env.DISCORD_MAP_SUBMIT_WEBHOOK;
  if (!webhookUrl) return;
  const categoryLabel = {
    "anime-song": "애니 노래", "kpop": "K-POP", "jpop": "J-POP",
    "ost": "OST", "vocaloid": "보컬로이드", "scene": "애니 장면", "character": "캐릭터 대사",
  }[map.category] || map.category || "기타";
  const body = {
    embeds: [{
      title: `📬 새 맵 검토 요청`,
      description: `**${map.icon || "🎵"} ${map.name}**`,
      color: 0xF59E0B,
      fields: [
        { name: "제작자", value: map.author || "알 수 없음", inline: true },
        { name: "카테고리", value: categoryLabel, inline: true },
        { name: "문제 수", value: `${map.questions?.length || 0}문제`, inline: true },
      ],
      footer: { text: "마추기온라인 관리자 알림" },
      timestamp: new Date().toISOString(),
    }]
  };
  _sendWebhook(webhookUrl, body);
}

async function sendDiscordMapApproved(map) {
  const webhookUrl = process.env.DISCORD_MAP_WEBHOOK;
  if (!webhookUrl) return;
  const siteUrl = process.env.ALLOWED_ORIGIN || "https://your-app.onrender.com";
  const questionCount = map.questions?.length || 0;
  const categoryLabel = {
    "anime-song": "애니 노래", "kpop": "K-POP", "jpop": "J-POP",
    "ost": "OST", "vocaloid": "보컬로이드", "scene": "장면", "character": "캐릭터",
  }[map.category] || map.category || "기타";

  const body = {
    embeds: [{
      title: `${map.icon || "🎵"} ${map.name}`,
      description: `새로운 맵이 승인되었습니다!`,
      color: 0x4ade80,
      fields: [
        { name: "제작자", value: map.author || "알 수 없음", inline: true },
        { name: "카테고리", value: categoryLabel, inline: true },
        { name: "문제 수", value: `${questionCount}문제`, inline: true },
      ],
      footer: { text: "마추기온라인" },
      timestamp: new Date().toISOString(),
    }],
    components: [{
      type: 1,
      components: [{
        type: 2, style: 5, label: "🎮 바로 플레이",
        url: siteUrl,
      }]
    }]
  };

  _sendWebhook(webhookUrl, body);
}

function _sendWebhook(webhookUrl, body, onMessageId) {
  try {
    const https = require("https");
    const data = JSON.stringify(body);
    const url = new URL(webhookUrl + (onMessageId ? "?wait=true" : ""));
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) }
    }, (res) => {
      if (onMessageId) {
        let raw = "";
        res.on("data", d => raw += d);
        res.on("end", () => {
          try { onMessageId(JSON.parse(raw).id); } catch {}
        });
      }
    });
    req.on("error", e => console.error("Discord webhook error:", e.message));
    req.write(data);
    req.end();
  } catch (e) { console.error("Discord webhook error:", e.message); }
}

function _deleteWebhookMessage(webhookUrl, messageId) {
  try {
    const https = require("https");
    const url = new URL(webhookUrl);
    const path = url.pathname + `/messages/${messageId}`;
    const req = https.request({ hostname: url.hostname, path, method: "DELETE" }, () => {});
    req.on("error", e => console.error("Discord webhook delete error:", e.message));
    req.end();
  } catch (e) { console.error("Discord webhook delete error:", e.message); }
}

function sendDiscordRoomCreated(room) {
  const webhookUrl = process.env.DISCORD_ROOM_WEBHOOK;
  if (!webhookUrl) return;
  const siteUrl = process.env.ALLOWED_ORIGIN || "https://your-app.onrender.com";
  const joinUrl = `${siteUrl}?join=${room.id}`;

  // 카테고리 → env 키 매핑
  const categoryRoleEnv = {
    "anime-song": "DISCORD_ROLE_ANIME_SONG",
    "kpop":       "DISCORD_ROLE_KPOP",
    "jpop":       "DISCORD_ROLE_JPOP",
    "ost":        "DISCORD_ROLE_OST",
    "vocaloid":   "DISCORD_ROLE_VOCALOID",
    "scene":      "DISCORD_ROLE_SCENE",
    "character":  "DISCORD_ROLE_CHARACTER",
  };
  const categoryLabel = {
    "anime-song": "🎵 애니 노래", "kpop": "🎤 K-POP", "jpop": "🌸 J-POP",
    "ost": "🎬 OST", "vocaloid": "🎤 보컬로이드", "scene": "🎞 애니 장면", "character": "🎭 캐릭터 대사",
  };

  const mapCategory = room.map?.category || "";
  const roleId = process.env[categoryRoleEnv[mapCategory]];
  const roleMention = roleId ? `<@&${roleId}>` : "";
  const catLabel = categoryLabel[mapCategory] || "기타";

  const body = {
    content: roleMention || undefined,
    allowed_mentions: roleId ? { roles: [roleId] } : { parse: [] },
    embeds: [{
      title: `🎮 ${room.name} 이 열렸어요!`,
      description: `${catLabel} 방에서 함께 플레이해요!`,
      color: 0x5865F2,
      fields: [
        { name: "🗺 맵", value: room.map?.name || "알 수 없음", inline: true },
        { name: "👑 호스트", value: room.hostName, inline: true },
        { name: "👥 인원", value: `${room.players.size}/${room.maxPlayers}명`, inline: true },
      ],
      footer: { text: "마추기온라인" },
      timestamp: new Date().toISOString(),
    }],
    components: [{
      type: 1,
      components: [{ type: 2, style: 5, label: "🚪 바로 입장하기", url: joinUrl }]
    }]
  };
  _sendWebhook(webhookUrl, body, (msgId) => {
    room.discordMsgId = msgId;
  });
}

function deleteDiscordRoomMessage(room) {
  const webhookUrl = process.env.DISCORD_ROOM_WEBHOOK;
  if (!webhookUrl || !room.discordMsgId) return;
  _deleteWebhookMessage(webhookUrl, room.discordMsgId);
  room.discordMsgId = null;
}

function adminMiddleware(req, res, next) {
  const token = req.cookies?.authToken || req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "로그인이 필요합니다" });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    if (!ADMIN_USERNAME || req.user.username !== ADMIN_USERNAME)
      return res.status(403).json({ error: "관리자 권한이 필요합니다" });
    next();
  } catch { res.status(401).json({ error: "토큰이 유효하지 않습니다" }); }
}

// ═══════════════════════════════════════════
// REST API — Auth
// ═══════════════════════════════════════════

app.post("/api/auth/register", async (req, res) => {
  try {
    const { username, password, avatar } = req.body;
    if (!username || !password) return res.status(400).json({ error: "아이디와 비밀번호를 입력해주세요" });
    if (username.length < 2 || username.length > 20) return res.status(400).json({ error: "아이디는 2~20자이어야 합니다" });
    // 9. 비밀번호 최소 8자
    if (password.length < 8) return res.status(400).json({ error: "비밀번호는 8자 이상이어야 합니다" });
    const existing = await UserModel.findOne({ username });
    if (existing) return res.status(400).json({ error: "이미 사용 중인 아이디입니다" });
    const hashed = await bcrypt.hash(password, 10);
    const user = await UserModel.create({ username, password: hashed, avatar: avatar || "🦊" });
    // 10. JWT 만료 7일
    const token = jwt.sign({ id: user._id.toString(), username: user.username, avatar: user.avatar }, JWT_SECRET, { expiresIn: "7d" });
    // 15. HttpOnly 쿠키 설정
    setTokenCookie(res, token);
    res.json({ token, user: { id: user._id.toString(), username: user.username, avatar: user.avatar, favorites: user.favorites || [], _isAdmin: ADMIN_USERNAME && user.username === ADMIN_USERNAME } });
  } catch (e) { console.error(e); res.status(500).json({ error: "서버 오류가 발생했습니다" }); }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    // 8. 로그인 브루트포스 방지
    const ip = req.ip || req.socket.remoteAddress;
    if (!checkLoginRateLimit(ip)) return res.status(429).json({ error: "로그인 시도가 너무 많습니다. 1분 후 다시 시도해주세요" });
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: "아이디와 비밀번호를 입력해주세요" });
    const user = await UserModel.findOne({ username });
    if (!user) return res.status(400).json({ error: "아이디 또는 비밀번호가 틀렸습니다" });
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(400).json({ error: "아이디 또는 비밀번호가 틀렸습니다" });
    // 10. JWT 만료 7일
    const token = jwt.sign({ id: user._id.toString(), username: user.username, avatar: user.avatar }, JWT_SECRET, { expiresIn: "7d" });
    // 15. HttpOnly 쿠키 설정
    setTokenCookie(res, token);
    res.json({ token, user: { id: user._id.toString(), username: user.username, avatar: user.avatar, favorites: user.favorites || [], _isAdmin: ADMIN_USERNAME && user.username === ADMIN_USERNAME } });
  } catch (e) { console.error(e); res.status(500).json({ error: "서버 오류가 발생했습니다" }); }
});

app.get("/api/auth/me", authMiddleware, async (req, res) => {
  try {
    const user = await UserModel.findById(req.user.id, "username avatar createdAt favorites");
    if (!user) return res.status(404).json({ error: "사용자를 찾을 수 없습니다" });
    res.json({ id: user._id.toString(), username: user.username, avatar: user.avatar, favorites: user.favorites || [], _isAdmin: ADMIN_USERNAME && user.username === ADMIN_USERNAME });
  } catch (e) { console.error(e); res.status(500).json({ error: "서버 오류가 발생했습니다" }); }
});

// 15. 로그아웃 — HttpOnly 쿠키 삭제
app.post("/api/auth/logout", (req, res) => {
  clearTokenCookie(res);
  res.json({ ok: true });
});

// ═══════════════════════════════════════════
// REST API — Maps
// ═══════════════════════════════════════════

app.get("/api/maps", async (req, res) => {
  try {
    const list = await MapModel.find({ status: "approved" }, "mapId name author icon category tags plays rating favoritesCount questions").lean();
    res.json(list.map(m => ({ id: m.mapId, name: m.name, author: m.author, icon: m.icon, category: m.category, tags: m.tags, questionCount: m.questions.length, plays: m.plays, rating: m.rating, favoritesCount: m.favoritesCount || 0 })));
  } catch (e) { console.error(e); res.status(500).json({ error: "서버 오류가 발생했습니다" }); }
});

app.get("/api/maps/mine", authMiddleware, async (req, res) => {
  try {
    const list = await MapModel.find(
      { $or: [{ authorId: req.user.id }, { author: req.user.username }] }
    ).lean();
    res.set("Cache-Control", "no-store");
    res.json(list.map(m => ({
      id:           m.mapId || m._id.toString(),
      mapId:        m.mapId || m._id.toString(),
      _id:          m._id.toString(),
      name:         m.name,
      icon:         m.icon,
      category:     m.category,
      tags:         m.tags,
      questionCount: (m.questions || []).length,
      plays:        m.plays,
      rating:       m.rating,
      author:       m.author,
      createdAt:    m.createdAt,
      status:       m.status || "draft",
      rejectReason: m.rejectReason || "",
      submittedAt:  m.submittedAt,
      approvedAt:   m.approvedAt,
    })));
  } catch (e) { console.error(e); res.status(500).json({ error: "서버 오류가 발생했습니다" }); }
});

// 즐겨찾기 목록 조회
app.get("/api/favorites", authMiddleware, async (req, res) => {
  try {
    const user = await UserModel.findById(req.user.id).lean();
    const favIds = user.favorites || [];
    if (!favIds.length) return res.json([]);
    const list = await MapModel.find({ mapId: { $in: favIds } }, "mapId name author icon category tags plays rating favoritesCount questions").lean();
    res.json(list.map(m => ({ id: m.mapId, name: m.name, author: m.author, icon: m.icon, category: m.category, tags: m.tags, questionCount: m.questions.length, plays: m.plays, rating: m.rating, favoritesCount: m.favoritesCount || 0 })));
  } catch (e) { console.error(e); res.status(500).json({ error: "서버 오류가 발생했습니다" }); }
});

// 즐겨찾기 토글
app.post("/api/favorites/:mapId", authMiddleware, async (req, res) => {
  try {
    const user = await UserModel.findById(req.user.id);
    const mapId = req.params.mapId;
    const idx = user.favorites.indexOf(mapId);
    const favorited = idx === -1;
    if (favorited) user.favorites.push(mapId);
    else user.favorites.splice(idx, 1);
    await user.save();
    // 맵 즐겨찾기 카운트 업데이트
    await MapModel.updateOne({ mapId }, { $inc: { favoritesCount: favorited ? 1 : -1 } });
    res.json({ favorited, favorites: user.favorites });
  } catch (e) { console.error(e); res.status(500).json({ error: "서버 오류가 발생했습니다" }); }
});

app.get("/api/maps/full/:id", authMiddleware, async (req, res) => {
  try {
    const m = await MapModel.findOne({ mapId: req.params.id }).lean();
    if (!m) return res.status(404).json({ error: "맵을 찾을 수 없습니다" });
    const isOwner = (m.authorId && m.authorId === req.user.id) || m.author === req.user.username;
    if (!isOwner) return res.status(403).json({ error: "이 맵의 수정 권한이 없습니다" });
    res.json({ ...m, id: m.mapId });
  } catch (e) { console.error(e); res.status(500).json({ error: "서버 오류가 발생했습니다" }); }
});

app.get("/api/maps/:id", async (req, res) => {
  try {
    const m = await MapModel.findOne({ mapId: req.params.id }).lean();
    if (!m) return res.status(404).json({ error: "맵을 찾을 수 없습니다" });
    res.json({ id: m.mapId, name: m.name, author: m.author, icon: m.icon, category: m.category, tags: m.tags, questions: m.questions.map(q => ({ id: q.id, type: q.type, hint: q.hint, timeLimit: q.timeLimit })) });
  } catch (e) { console.error(e); res.status(500).json({ error: "서버 오류가 발생했습니다" }); }
});

// 14. 맵 입력값 검증 헬퍼
function validateMapInput(name, questions) {
  if (!name || typeof name !== "string") return "맵 이름을 입력해주세요";
  if (name.trim().length < 1 || name.trim().length > 50) return "맵 이름은 1~50자이어야 합니다";
  if (!Array.isArray(questions) || questions.length === 0) return "최소 1개의 문제가 필요합니다";
  if (questions.length > 500) return "문제는 최대 500개까지 가능합니다";
  return null;
}

app.post("/api/maps", authMiddleware, async (req, res) => {
  try {
    const { name, icon, category, tags, questions } = req.body;
    const err = validateMapInput(name, questions);
    if (err) return res.status(400).json({ error: err });
    const mapId = "map-" + uuidv4().slice(0, 8);
    await MapModel.create({ mapId, name: name.trim(), author: req.user.username, authorId: req.user.id, icon: icon || "🎵", category: category || "anime-song", tags: Array.isArray(tags) ? tags.slice(0, 10) : [], questions: normalizeQuestions(questions) });
    res.json({ id: mapId, message: "맵이 생성되었습니다!" });
  } catch (e) { console.error(e); res.status(500).json({ error: "서버 오류가 발생했습니다" }); }
});

app.put("/api/maps/:id", authMiddleware, async (req, res) => {
  try {
    const m = await MapModel.findOne({ mapId: req.params.id });
    if (!m) return res.status(404).json({ error: "맵을 찾을 수 없습니다" });
    const isOwner = (m.authorId && m.authorId === req.user.id) || m.author === req.user.username;
    if (!isOwner) return res.status(403).json({ error: "수정 권한이 없습니다" });
    const { name, icon, category, tags, questions } = req.body;
    if (questions) {
      const err = validateMapInput(name || m.name, questions);
      if (err) return res.status(400).json({ error: err });
    }
    if (name) m.name = name.trim().slice(0, 50);
    if (icon) m.icon = icon;
    if (category) m.category = category;
    if (Array.isArray(tags)) m.tags = tags.slice(0, 10);
    if (questions && questions.length > 0) m.questions = normalizeQuestions(questions);
    await m.save();
    res.json({ message: "맵이 수정되었습니다!" });
  } catch (e) { console.error(e); res.status(500).json({ error: "서버 오류가 발생했습니다" }); }
});

app.delete("/api/maps/:id", authMiddleware, async (req, res) => {
  try {
    const m = await MapModel.findOne({ mapId: req.params.id });
    if (!m) return res.status(404).json({ error: "맵을 찾을 수 없습니다" });
    const isOwner2 = (m.authorId && m.authorId === req.user.id) || m.author === req.user.username;
    if (!isOwner2) return res.status(403).json({ error: "삭제 권한이 없습니다" });
    await MapModel.deleteOne({ mapId: req.params.id });
    res.json({ message: "맵이 삭제되었습니다!" });
  } catch (e) { console.error(e); res.status(500).json({ error: "서버 오류가 발생했습니다" }); }
});

// ── 배포 신청 (draft / rejected → pending) ──
app.post("/api/maps/:id/submit", authMiddleware, async (req, res) => {
  try {
    const rid = req.params.id;
    const m = await MapModel.findOne(
      mongoose.Types.ObjectId.isValid(rid)
        ? { $or: [{ mapId: rid }, { _id: rid }] }
        : { mapId: rid }
    );
    if (!m) return res.status(404).json({ error: "맵을 찾을 수 없습니다" });
    const isOwner = (m.authorId && m.authorId === req.user.id) || m.author === req.user.username;
    if (!isOwner) return res.status(403).json({ error: "권한이 없습니다" });
    if (m.status === "pending") return res.status(400).json({ error: "이미 검토 중입니다" });
    if (m.status === "approved") return res.status(400).json({ error: "이미 배포된 맵입니다" });
    if (m.questions.length === 0) return res.status(400).json({ error: "문제가 없습니다" });
    m.status = "pending";
    m.rejectReason = "";
    m.submittedAt = new Date();
    await m.save();
    sendDiscordMapSubmitted(m);
    res.json({ ok: true, status: "pending" });
  } catch (e) { console.error(e); res.status(500).json({ error: "서버 오류가 발생했습니다" }); }
});

// ── 배포 신청 취소 (pending → draft) ──
app.post("/api/maps/:id/cancel-submit", authMiddleware, async (req, res) => {
  try {
    const rid = req.params.id;
    const m = await MapModel.findOne(
      mongoose.Types.ObjectId.isValid(rid)
        ? { $or: [{ mapId: rid }, { _id: rid }] }
        : { mapId: rid }
    );
    if (!m) return res.status(404).json({ error: "맵을 찾을 수 없습니다" });
    const isOwner = (m.authorId && m.authorId === req.user.id) || m.author === req.user.username;
    if (!isOwner) return res.status(403).json({ error: "권한이 없습니다" });
    if (m.status !== "pending") return res.status(400).json({ error: "검토 중인 맵이 아닙니다" });
    m.status = "draft";
    await m.save();
    res.json({ ok: true, status: "draft" });
  } catch (e) { console.error(e); res.status(500).json({ error: "서버 오류가 발생했습니다" }); }
});

// ═══════════════════════════════════════════
// REST API — 관리자
// ═══════════════════════════════════════════

// 대기 중인 맵 목록
app.get("/api/admin/maps", adminMiddleware, async (req, res) => {
  try {
    const list = await MapModel.find({ status: "pending" }, "mapId name author icon category tags plays questions submittedAt createdAt").lean();
    res.json(list.map(m => ({ id: m.mapId, name: m.name, author: m.author, icon: m.icon, category: m.category, tags: m.tags, questionCount: m.questions.length, submittedAt: m.submittedAt, createdAt: m.createdAt })));
  } catch (e) { console.error(e); res.status(500).json({ error: "서버 오류가 발생했습니다" }); }
});

// 맵 상세 조회 (관리자용 — 전체 문제 포함)
app.get("/api/admin/maps/:id", adminMiddleware, async (req, res) => {
  try {
    const m = await MapModel.findOne({ mapId: req.params.id }).lean();
    if (!m) return res.status(404).json({ error: "맵을 찾을 수 없습니다" });
    res.json({ ...m, id: m.mapId });
  } catch (e) { console.error(e); res.status(500).json({ error: "서버 오류가 발생했습니다" }); }
});

// 승인
app.post("/api/admin/maps/:id/approve", adminMiddleware, async (req, res) => {
  try {
    const m = await MapModel.findOne({ mapId: req.params.id });
    if (!m) return res.status(404).json({ error: "맵을 찾을 수 없습니다" });
    m.status = "approved";
    m.rejectReason = "";
    m.approvedAt = new Date();
    await m.save();
    sendDiscordMapApproved(m);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: "서버 오류가 발생했습니다" }); }
});

// 거절
app.post("/api/admin/maps/:id/reject", adminMiddleware, async (req, res) => {
  try {
    const { reason } = req.body;
    const m = await MapModel.findOne({ mapId: req.params.id });
    if (!m) return res.status(404).json({ error: "맵을 찾을 수 없습니다" });
    m.status = "rejected";
    m.rejectReason = reason || "";
    await m.save();
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: "서버 오류가 발생했습니다" }); }
});

app.get("/api/ranking", async (req, res) => {
  try { res.json(await RankingModel.find().sort({ score: -1 }).limit(100).lean()); }
  catch (e) { console.error(e); res.status(500).json({ error: "서버 오류가 발생했습니다" }); }
});

app.get("/api/rooms", (req, res) => {
  res.json(Array.from(rooms.values()).filter(r => r.status !== "finished").map(r => ({
    id: r.id, name: r.name, hostName: r.hostName, mapId: r.mapId,
    mapName: r.map?.name || "알 수 없음", mapIcon: r.map?.icon || "❓",
    players: r.players.size, maxPlayers: r.maxPlayers, status: r.status,
  })));
});

app.get("/api/status", async (req, res) => {
  try { res.json({ online: onlineCount, rooms: rooms.size, maps: await MapModel.countDocuments() }); }
  catch { res.json({ online: onlineCount, rooms: rooms.size, maps: 0 }); }
});

// 전역 에러 핸들러 — 어디서든 예외 발생 시 HTML 대신 JSON 반환
app.use((err, req, res, next) => {
  console.error("❌ 서버 오류:", err.message);
  res.status(500).json({ error: "서버 오류가 발생했습니다" });
});

app.get("*", (req, res) => res.sendFile(path.join(__dirname, "../public/index.html")));

// ═══════════════════════════════════════════
// Room
// ═══════════════════════════════════════════

function createRoom(id, name, hostId, hostName, hostAvatar, mapId, maxPlayers, password) {
  return {
    id, name, hostId, hostName, hostAvatar, mapId,
    maxPlayers: Math.min(Math.max(maxPlayers, 1), 8),
    password: password || "",
    players: new Map(),
    spectators: new Map(),
    status: "waiting",
    currentQuestion: 0,
    answeredSubQs: new Map(),
    skipVoters: new Set(),
    timer: null,
    timeLeft: 0,
    map: null,
    createdAt: Date.now(),
  };
}

// ═══════════════════════════════════════════
// Socket.IO
// ═══════════════════════════════════════════

// JWT 인증 미들웨어 — 토큰 없으면 연결 거부
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error("인증 토큰이 필요합니다"));
  try {
    socket.jwtUser = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    next(new Error("유효하지 않은 토큰입니다"));
  }
});

io.on("connection", (socket) => {
  onlineCount++;
  io.emit("onlineCount", onlineCount);
  console.log(`[+] ${socket.id} (온라인: ${onlineCount})`);

  // register: JWT에서 사용자 정보를 가져옴 (클라이언트가 임의 이름 주입 불가)
  socket.on("register", () => {
    const u = socket.jwtUser;
    users.set(socket.id, { id: socket.id, name: u.username, avatar: u.avatar || "🦊", score: 0, userId: u.id });
    socket.emit("registered", users.get(socket.id));
  });

  socket.on("getRooms", () => {
    socket.emit("roomList", Array.from(rooms.values()).map(r => ({
      id: r.id, name: r.name, hostName: r.hostName, mapId: r.mapId,
      mapName: r.map?.name || "알 수 없음", mapIcon: r.map?.icon || "❓",
      players: r.players.size, maxPlayers: r.maxPlayers, status: r.status,
      hasPassword: !!r.password,
    })));
  });

  socket.on("getMaps", async () => {
    try {
      const list = await MapModel.find({ status: "approved" }, "mapId name author icon category tags plays rating favoritesCount questions").lean();
      socket.emit("mapList", list.map(m => ({ id: m.mapId, name: m.name, author: m.author, icon: m.icon, category: m.category, tags: m.tags, questionCount: m.questions.length, plays: m.plays, rating: m.rating, favoritesCount: m.favoritesCount || 0 })));
    } catch { socket.emit("mapList", []); }
  });

  // 내 맵 목록 (방 만들기용 — 승인 여부 무관)
  socket.on("getMyMaps", async () => {
    try {
      const user = users.get(socket.id);
      if (!user || !user.userId) return socket.emit("myMapList", []);
      const list = await MapModel.find(
        { $or: [{ authorId: user.userId }, { author: user.name }] },
        "mapId name author icon category tags plays rating questions status"
      ).lean();
      socket.emit("myMapList", list.map(m => ({ id: m.mapId, name: m.name, author: m.author, icon: m.icon, category: m.category, tags: m.tags, questionCount: m.questions.length, plays: m.plays, rating: m.rating, status: m.status || "draft" })));
    } catch { socket.emit("myMapList", []); }
  });

  socket.on("createRoom", async ({ name, mapId, maxPlayers, password }) => {
    const user = users.get(socket.id);
    if (!user) return socket.emit("error", "먼저 등록해주세요");
    // 방 생성 레이트 리밋: 1분에 최대 5개
    const uid = user.userId;
    const now = Date.now();
    const recentCreates = (_roomCreateLog.get(uid) || []).filter(t => now - t < 60000);
    if (recentCreates.length >= 5) return socket.emit("error", "방 생성은 1분에 5개까지만 가능합니다");
    recentCreates.push(now);
    _roomCreateLog.set(uid, recentCreates);
    try {
      const map = await MapModel.findOne({ mapId }).lean();
      if (!map) return socket.emit("error", "맵을 찾을 수 없습니다");
      const roomId = "room-" + uuidv4().slice(0, 8);
      // 13. 방 비밀번호 해시화
      const hashedPw = password ? await bcrypt.hash(password, 6) : "";
      const room = createRoom(roomId, name, socket.id, user.name, user.avatar, mapId, maxPlayers, hashedPw);
      room.map = map;
      room.players.set(socket.id, { ...user, score: 0, answeredSubQs: new Set() });
      rooms.set(roomId, room);
      socket.join(roomId);
      socket.emit("roomJoined", getRoomState(room));
      if (!password) sendDiscordRoomCreated(room); // 공개방만 알림
      broadcastRoomList();
    } catch (e) { console.error(e); socket.emit("error", "방 생성에 실패했습니다"); }
  });

  socket.on("joinRoom", async ({ roomId, password }) => {
    const user = users.get(socket.id);
    if (!user) return socket.emit("error", "먼저 등록해주세요");
    const room = rooms.get(roomId);
    if (!room) return socket.emit("error", "방을 찾을 수 없습니다");
    if (room.status !== "waiting") return socket.emit("error", "이미 게임이 진행 중입니다");
    if (room.players.size >= room.maxPlayers) return socket.emit("error", "방이 가득 찼습니다");
    // 13. 해시된 비밀번호 비교
    if (room.password) {
      const pwMatch = await bcrypt.compare(password || "", room.password);
      if (!pwMatch) return socket.emit("error", "비밀번호가 틀렸습니다", { roomId });
    }
    room.players.set(socket.id, { ...user, score: 0, answeredSubQs: new Set() });
    socket.join(roomId);
    socket.emit("roomJoined", getRoomState(room));
    io.to(roomId).emit("playerJoined", { player: { id: socket.id, name: user.name, avatar: user.avatar }, players: getPlayersArray(room) });
    broadcastRoomList();
  });

  // ── 관전 입장 ──
  socket.on("watchRoom", async ({ roomId, password }) => {
    const user = users.get(socket.id);
    console.log(`[watchRoom] sid=${socket.id} roomId=${roomId} user=${user?.name}`);
    if (!user) return socket.emit("error", "먼저 등록해주세요");
    const room = rooms.get(roomId);
    if (!room) return socket.emit("error", "방을 찾을 수 없습니다");
    if (room.status === "finished") return socket.emit("error", "이미 종료된 게임입니다");
    if (room.password) {
      const pwMatch = await bcrypt.compare(password || "", room.password);
      if (!pwMatch) return socket.emit("error", "비밀번호가 틀렸습니다", { roomId });
    }
    room.spectators.set(socket.id, { ...user });
    socket.join(roomId);
    // 현재 게임 상태 전송
    const roomState = getRoomState(room);
    roomState.spectating = true;
    if (room.status === "playing" && room.map) {
      const q = room.map.questions[room.currentQuestion];
      const subQs = getSubQuestions(q);
      roomState.midGameState = {
        currentQuestion: room.currentQuestion,
        totalQuestions: room.map.questions.length,
        type: q.type,
        timeLimit: q.timeLimit || 30,
        timeLeft: room.timeLeft,
        mediaUrl: q.mediaUrl || "",
        startTime: q.startTime || 0,
        endTime: q.endTime || 0,
        volume: (q.volume !== undefined && q.volume !== null) ? q.volume : 100,
        subQuestions: subQs.map((sq, i) => ({ index: i, prompt: sq.prompt || q.hint || "" })),
        scores: getScoresArray(room),
      };
    }
    socket.emit("roomJoined", roomState);
    io.to(roomId).emit("chatMessage", { type: "system", text: `👁 ${user.name}님이 관전 중입니다.` });
  });

  socket.on("leaveRoom", () => leaveAllRooms(socket));

  socket.on("startGame", async ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    if (room.hostId !== socket.id) return socket.emit("error", "호스트만 시작할 수 있습니다");
    try {
      const map = await MapModel.findOne({ mapId: room.mapId }).lean();
      if (!map) return socket.emit("error", "맵 데이터를 찾을 수 없습니다");
      // Shuffle questions (Fisher-Yates)
      const qs = [...map.questions];
      for (let i = qs.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [qs[i], qs[j]] = [qs[j], qs[i]];
      }
      map.questions = qs;
      room.map = map;
      room.status = "playing";
      room.currentQuestion = 0;
      deleteDiscordRoomMessage(room);
      room.players.forEach(p => { p.score = 0; p.answeredSubQs = new Set(); });
      await MapModel.updateOne({ mapId: room.mapId }, { $inc: { plays: 1 } });
      io.to(roomId).emit("gameStarted", { totalQuestions: map.questions.length, players: getPlayersArray(room) });
      sendQuestion(room);
      broadcastRoomList();
    } catch (e) { console.error(e); socket.emit("error", "게임 시작에 실패했습니다"); }
  });

  // ── 정답 제출 ──
  socket.on("submitAnswer", ({ roomId, answer, subQIndex }) => {
    const room = rooms.get(roomId);
    if (!room || room.status !== "playing" || !room.map) return;
    const player = room.players.get(socket.id);
    if (!player) return;

    const question = room.map.questions[room.currentQuestion];
    if (!question) return;
    const subQs = getSubQuestions(question);
    const normalizedAnswer = answer.toLowerCase().trim();

    // 이 플레이어가 아직 안 맞춘 소문제 중 정답 스캔
    let matchedIdx = -1;
    for (let i = 0; i < subQs.length; i++) {
      if (player.answeredSubQs.has(i)) continue;
      if (subQs[i].answers.some(a => a.toLowerCase().trim() === normalizedAnswer)) {
        matchedIdx = i; break;
      }
    }

    socket.emit("chatMessage", { type: "answer", name: player.name, text: answer });

    if (matchedIdx >= 0) {
      player.answeredSubQs.add(matchedIdx);
      if (!room.answeredSubQs.has(matchedIdx)) room.answeredSubQs.set(matchedIdx, new Set());
      room.answeredSubQs.get(matchedIdx).add(socket.id);

      const orderInSubQ = room.answeredSubQs.get(matchedIdx).size;
      const points = Math.max(1, room.players.size - (orderInSubQ - 1));
      player.score += points;

      const revealedAnswer = subQs[matchedIdx].answers[0] || answer;
      socket.emit("correctAnswer", {
        playerId: socket.id, playerName: player.name, playerAvatar: player.avatar,
        points, order: orderInSubQ, subQIndex: matchedIdx, scores: getScoresArray(room),
        subQTotal: room.players.size, subQCount: orderInSubQ, answer: revealedAnswer,
      });
      socket.to(roomId).emit("correctAnswer", {
        playerId: socket.id, playerName: player.name, playerAvatar: player.avatar,
        points, order: orderInSubQ, subQIndex: matchedIdx, scores: getScoresArray(room),
        subQTotal: room.players.size, subQCount: orderInSubQ,
      });
      io.to(roomId).emit("chatMessage", { type: "correct", text: `${player.name}님이 [${subQs[matchedIdx].prompt || `문제${matchedIdx+1}`}] 정답! (+${points}점)` });

      const allDone = subQs.every((_, i) => (room.answeredSubQs.get(i)?.size ?? 0) >= room.players.size);
      if (allDone || allPlayersDoneOrSkipped(room, subQs)) {
        clearInterval(room.timer);
        io.to(roomId).emit("chatMessage", { type: "system", text: "모든 플레이어가 완료!" });
        setTimeout(() => nextQuestion(room), 1500);
      }
    } else {
      socket.emit("wrongAnswer", { text: "오답!" });
    }
  });

  // ── 스킵 투표 ──
  socket.on("skipVote", ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || room.status !== "playing" || !room.map) return;
    const player = room.players.get(socket.id);
    if (!player) return;

    room.skipVoters.add(socket.id);
    const question = room.map.questions[room.currentQuestion];
    const subQs = getSubQuestions(question);

    // 아직 완료 못한 플레이어만 스킵 대상으로 계산
    const pendingPlayers = [...room.players.entries()].filter(([sid, p]) =>
      !subQs.every((_, i) => p.answeredSubQs.has(i))
    );
    const votes = [...room.skipVoters].filter(sid =>
      pendingPlayers.some(([s]) => s === sid)
    ).length;
    const total = pendingPlayers.length || room.players.size;
    // 1~2명: 전원 스킵, 3명 이상: 과반수
    const needed = total >= 3 ? Math.floor(total / 2) + 1 : total;
    io.to(roomId).emit("skipVoteUpdate", { votes, total, needed });

    // 완료한 플레이어 제외하고 나머지가 모두 스킵 눌렀으면 진행
    if (votes >= needed || allPlayersDoneOrSkipped(room, subQs)) {
      clearInterval(room.timer);
      // 미답 서브퀴즈 정답 공개 — 모든 플레이어가 맞춘 경우만 answered:true
      const revealList = subQs.map((sq, i) => ({ prompt: sq.prompt || `문제${i+1}`, answer: sq.showAnswer !== false ? ((sq.answers || [])[0] || "?") : null, answered: (room.answeredSubQs.get(i)?.size ?? 0) >= room.players.size }));
      io.to(roomId).emit("timeUp", { revealList, scores: getScoresArray(room) });
      const unanswered = revealList.filter(r => !r.answered).map(r => `${r.prompt}: ${r.answer}`).join(", ");
      io.to(roomId).emit("chatMessage", { type: "system", text: `⏭ 스킵! 정답: ${unanswered}` });
      setTimeout(() => nextQuestion(room), 2000);
    }
  });

  socket.on("chat", ({ roomId, message }) => {
    const user = users.get(socket.id);
    if (!user || !message?.trim()) return;
    const msg = message.trim();
    if (msg.length > 300) return; // 메시지 최대 길이 제한
    const room = rooms.get(roomId);

    // 게임 중이면 정답 체크 먼저 (레이트 리밋 적용 안 함 — 빠른 연속 정답 허용)
    if (room && room.status === "playing" && room.map) {
      const player = room.players.get(socket.id);
      const question = room.map.questions[room.currentQuestion];
      if (player && question) {
        const subQs = getSubQuestions(question);
        const normalized = msg.toLowerCase();
        let matchedIdx = -1;
        for (let i = 0; i < subQs.length; i++) {
          if (player.answeredSubQs.has(i)) continue; // 이 플레이어가 이미 맞춘 소문제 제외
          if (subQs[i].answers.some(a => a.toLowerCase().trim() === normalized)) {
            matchedIdx = i; break;
          }
        }
        if (matchedIdx >= 0) {
          player.answeredSubQs.add(matchedIdx);
          // answeredSubQs: Map(subQIndex → Set(playerId))
          if (!room.answeredSubQs.has(matchedIdx)) room.answeredSubQs.set(matchedIdx, new Set());
          room.answeredSubQs.get(matchedIdx).add(socket.id);

          const orderInSubQ = room.answeredSubQs.get(matchedIdx).size; // 이 소문제 내 순위
          const points = Math.max(1, room.players.size - (orderInSubQ - 1));
          player.score += points;

          const revealedAnswer2 = subQs[matchedIdx].answers[0] || msg;
          socket.emit("correctAnswer", {
            playerId: socket.id, playerName: player.name, playerAvatar: player.avatar,
            points, order: orderInSubQ, subQIndex: matchedIdx, scores: getScoresArray(room),
            subQTotal: room.players.size, subQCount: orderInSubQ, answer: revealedAnswer2,
          });
          socket.to(roomId).emit("correctAnswer", {
            playerId: socket.id, playerName: player.name, playerAvatar: player.avatar,
            points, order: orderInSubQ, subQIndex: matchedIdx, scores: getScoresArray(room),
            subQTotal: room.players.size, subQCount: orderInSubQ,
          });
          io.to(roomId).emit("chatMessage", { type: "correct", text: `${player.name}님이 [${subQs[matchedIdx].prompt || `문제${matchedIdx+1}`}] 정답! (+${points}점)` });

          // 모든 플레이어가 모든 소문제를 맞췄는지 (또는 스킵+완료 조합)
          const allDone = subQs.every((_, i) => (room.answeredSubQs.get(i)?.size ?? 0) >= room.players.size);
          if (allDone || allPlayersDoneOrSkipped(room, subQs)) {
            clearInterval(room.timer);
            io.to(roomId).emit("chatMessage", { type: "system", text: "모든 플레이어가 완료!" });
            setTimeout(() => nextQuestion(room), 1500);
          }
          return; // 정답이면 채팅으로 안 보냄
        }
      }
    }

    // 정답 아니면 일반 채팅 — 여기서만 레이트 리밋 적용 (스팸 방지)
    const nowChat = Date.now();
    if (nowChat - (user._lastChat || 0) < 500) return;
    user._lastChat = nowChat;
    io.to(roomId).emit("chatMessage", { type: "chat", name: user.name, text: msg });
  });

  socket.on("disconnect", () => {
    onlineCount = Math.max(0, onlineCount - 1);
    io.emit("onlineCount", onlineCount);
    leaveAllRooms(socket);
    users.delete(socket.id);
    console.log(`[-] ${socket.id} (온라인: ${onlineCount})`);
  });
});

// ═══════════════════════════════════════════
// Game Logic
// ═══════════════════════════════════════════

function sendQuestion(room) {
  if (!room.map) return;
  const q = room.map.questions[room.currentQuestion];
  if (!q) return;

  const subQs = getSubQuestions(q);
  const timeLimit = q.timeLimit || 30;

  // 서브퀴즈 상태 초기화
  room.answeredSubQs = new Map();
  room.skipVoters = new Set();
  room.timeLeft = timeLimit;
  room.players.forEach(p => { p.answeredSubQs = new Set(); });

  io.to(room.id).emit("question", {
    index: room.currentQuestion,
    total: room.map.questions.length,
    type: q.type,
    anime: q.anime,
    timeLimit,
    mediaUrl: q.mediaUrl || "",
    startTime: q.startTime || 0,
    endTime: q.endTime || 0,
    volume: (q.volume !== undefined && q.volume !== null) ? q.volume : 100,
    songIndex: room.currentQuestion,
    totalSongs: room.map.questions.length,
    // 모든 서브퀴즈 한 번에 전송 (정답 제외)
    subQuestions: subQs.map((sq, i) => ({ index: i, prompt: sq.prompt || q.hint || "", chosungHint: sq.chosungHint && hasKorean((sq.answers || [])[0] || "") })),
  });

  clearTimeout(room.timer);
  room.timer = setInterval(() => {
    room.timeLeft--;
    io.to(room.id).emit("timeUpdate", room.timeLeft);

    // 초성 힌트 공개 (각 서브퀴즈별, 플레이어별 개별 적용)
    subQs.forEach((sq, i) => {
      if (!sq.chosungHint || !sq.hintRevealTime) return;
      const firstAnswer = (sq.answers || [])[0] || "";
      if (!hasKorean(firstAnswer)) return;
      const revealAt = timeLimit - sq.hintRevealTime;
      if (room.timeLeft === revealAt) {
        const hint = getChosung(firstAnswer);
        // 아직 이 소문제 못 맞춘 플레이어에게만 전송
        room.players.forEach((p, sid) => {
          if (!p.answeredSubQs.has(i)) {
            io.to(sid).emit("hintReveal", { subQIndex: i, hint });
          }
        });
        io.to(room.id).emit("chatMessage", { type: "system", text: `💡 [${sq.prompt || `문제${i+1}`}] 초성 힌트: ${hint}` });
      }
    });

    if (room.timeLeft <= 0) {
      clearInterval(room.timer);
      const revealList = subQs.map((sq, i) => ({ prompt: sq.prompt || `문제${i+1}`, answer: sq.showAnswer !== false ? ((sq.answers || [])[0] || "?") : null, answered: (room.answeredSubQs.get(i)?.size ?? 0) >= room.players.size }));
      io.to(room.id).emit("timeUp", { revealList, scores: getScoresArray(room) });
      const unanswered = revealList.filter(r => !r.answered);
      if (unanswered.length > 0) {
        io.to(room.id).emit("chatMessage", { type: "system", text: `시간 초과! 정답: ${unanswered.map(r => `${r.prompt}: ${r.answer}`).join(", ")}` });
      }
      setTimeout(() => nextQuestion(room), 3000);
    }
  }, 1000);
}

function nextQuestion(room) {
  room.currentQuestion++;
  if (!room.map || room.currentQuestion >= room.map.questions.length) {
    room.status = "finished";
    clearInterval(room.timer);
    const finalScores = getScoresArray(room);
    io.to(room.id).emit("gameOver", { scores: finalScores });
    io.to(room.id).emit("chatMessage", { type: "system", text: "🏆 게임 종료!" });
    const mapName = room.map?.name || "알 수 없음";
    const mapId = String(room.map?._id || room.map?.id || room.mapId || "");
    // 맵당 최고점수만 유지 — 현재 점수가 더 높을 때만 upsert
    for (const p of finalScores.filter(s => s.score > 0)) {
      const userId = p.userId || p.name; // 로그인 유저면 userId, 아니면 name
      if (!mapId) {
        // mapId 없으면 그냥 insert (레거시)
        RankingModel.create({ userId, name: p.name, avatar: p.avatar, score: p.score, mapId: mapId||userId+mapName, mapName })
          .catch(() => {});
      } else {
        // 기존 최고점수보다 높을 때만 score 갱신
        RankingModel.findOneAndUpdate(
          { userId, mapId },
          { $max: { score: p.score }, $set: { name: p.name, avatar: p.avatar, mapName, date: new Date() } },
          { upsert: true }
        ).catch(e => console.error("랭킹 저장 실패:", e.message));
      }
    }
    setTimeout(() => { if (rooms.has(room.id)) { clearInterval(room.timer); rooms.delete(room.id); broadcastRoomList(); } }, 3000);
    broadcastRoomList();
    return;
  }
  sendQuestion(room);
}

function leaveAllRooms(socket) {
  rooms.forEach((room, roomId) => {
    const user = users.get(socket.id);
    // 관전자면 조용히 제거
    if (room.spectators.has(socket.id)) {
      room.spectators.delete(socket.id);
      socket.leave(roomId);
      return;
    }
    if (!room.players.has(socket.id)) return;
    room.players.delete(socket.id);
    socket.leave(roomId);
    io.to(roomId).emit("playerLeft", { playerId: socket.id, playerName: user?.name || "???", players: getPlayersArray(room) });
    io.to(roomId).emit("chatMessage", { type: "system", text: `${user?.name || "???"} 님이 나갔습니다.` });
    if (room.players.size === 0) { deleteDiscordRoomMessage(room); clearInterval(room.timer); rooms.delete(roomId); }
    else if (room.hostId === socket.id) {
      const nextHost = room.players.keys().next().value;
      room.hostId = nextHost;
      room.hostName = room.players.get(nextHost)?.name || "???";
      io.to(roomId).emit("newHost", { hostId: nextHost, hostName: room.hostName });
    }
    broadcastRoomList();
  });
}

function getRoomState(room) {
  return { id: room.id, name: room.name, hostId: room.hostId, hostName: room.hostName, mapId: room.mapId, mapName: room.map?.name || "알 수 없음", mapIcon: room.map?.icon || "❓", questionCount: room.map?.questions?.length || 0, maxPlayers: room.maxPlayers, status: room.status, players: getPlayersArray(room) };
}
function getPlayersArray(room) {
  return Array.from(room.players.entries()).map(([sid, p]) => ({ id: sid, name: p.name, avatar: p.avatar, score: p.score, isHost: sid === room.hostId }));
}
function getScoresArray(room) {
  return Array.from(room.players.values()).map(p => ({ name: p.name, avatar: p.avatar, score: p.score, userId: p.userId || p.name })).sort((a, b) => b.score - a.score);
}
function broadcastRoomList() {
  io.emit("roomList", Array.from(rooms.values()).filter(r => r.status !== "finished").map(r => ({
    id: r.id, name: r.name, hostName: r.hostName, mapId: r.mapId,
    mapName: r.map?.name || "알 수 없음", mapIcon: r.map?.icon || "❓",
    players: r.players.size, maxPlayers: r.maxPlayers, status: r.status,
    hasPassword: !!r.password,
  })));
}

// ═══════════════════════════════════════════
// ── 버그 제보 ──
app.post("/api/bug-report", authMiddleware, async (req, res) => {
  const { title, description } = req.body;
  if (!title?.trim() || !description?.trim())
    return res.status(400).json({ error: "제목과 내용을 입력해주세요" });

  const webhookUrl = process.env.DISCORD_BUG_WEBHOOK;
  if (webhookUrl) {
    _sendWebhook(webhookUrl, {
      embeds: [{
        title: `🐛 버그 제보: ${title.trim()}`,
        description: description.trim(),
        color: 0xEF4444,
        fields: [{ name: "제보자", value: req.user.username, inline: true }],
        footer: { text: "마추기온라인 버그 제보" },
        timestamp: new Date().toISOString(),
      }]
    });
  }
  res.json({ ok: true });
});

// Start
// ═══════════════════════════════════════════

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════╗
║   🎯 마추기온라인.io 서버 시작!           ║
║   http://localhost:${PORT}                  ║
╚═══════════════════════════════════════════╝`);
});
