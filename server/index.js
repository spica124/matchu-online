// ═══════════════════════════════════════════════════════════════
// 마추기온라인.io — Server (Express + Socket.IO + MongoDB + Auth)
// ═══════════════════════════════════════════════════════════════

require("dotenv").config();
const express   = require("express");
const http      = require("http");
const { Server } = require("socket.io");
const path      = require("path");
const { v4: uuidv4 } = require("uuid");
const mongoose  = require("mongoose");
const bcrypt    = require("bcryptjs");
const jwt       = require("jsonwebtoken");

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: "*" }, pingTimeout: 60000, pingInterval: 25000 });

app.use(express.static(path.join(__dirname, "../public")));
app.use(express.json());

const JWT_SECRET   = process.env.JWT_SECRET || "matchu-secret";
const MONGODB_URI  = process.env.MONGODB_URI || "mongodb://localhost:27017/matchu-online";

// ═══════════════════════════════════════════
// MongoDB
// ═══════════════════════════════════════════

mongoose.connect(MONGODB_URI)
  .then(() => console.log("✅ MongoDB 연결 성공"))
  .catch(e  => console.error("❌ MongoDB 연결 실패:", e.message));

// ── Schemas ──

const userSchema = new mongoose.Schema({
  username:  { type: String, required: true, unique: true, trim: true },
  password:  { type: String, required: true },
  avatar:    { type: String, default: "🦊" },
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
  plays:     { type: Number, default: 0 },
  rating:    { type: Number, default: 0 },
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

// ── Auth Middleware ──
function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "로그인이 필요합니다" });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
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
    if (username.length < 2) return res.status(400).json({ error: "아이디는 2자 이상이어야 합니다" });
    if (password.length < 4) return res.status(400).json({ error: "비밀번호는 4자 이상이어야 합니다" });
    const existing = await UserModel.findOne({ username });
    if (existing) return res.status(400).json({ error: "이미 사용 중인 아이디입니다" });
    const hashed = await bcrypt.hash(password, 10);
    const user = await UserModel.create({ username, password: hashed, avatar: avatar || "🦊" });
    const token = jwt.sign({ id: user._id.toString(), username: user.username, avatar: user.avatar }, JWT_SECRET, { expiresIn: "30d" });
    res.json({ token, user: { id: user._id.toString(), username: user.username, avatar: user.avatar } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: "아이디와 비밀번호를 입력해주세요" });
    const user = await UserModel.findOne({ username });
    if (!user) return res.status(400).json({ error: "아이디 또는 비밀번호가 틀렸습니다" });
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(400).json({ error: "아이디 또는 비밀번호가 틀렸습니다" });
    const token = jwt.sign({ id: user._id.toString(), username: user.username, avatar: user.avatar }, JWT_SECRET, { expiresIn: "30d" });
    res.json({ token, user: { id: user._id.toString(), username: user.username, avatar: user.avatar } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/auth/me", authMiddleware, async (req, res) => {
  try {
    const user = await UserModel.findById(req.user.id, "username avatar createdAt");
    if (!user) return res.status(404).json({ error: "사용자를 찾을 수 없습니다" });
    res.json({ id: user._id.toString(), username: user.username, avatar: user.avatar });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════
// REST API — Maps
// ═══════════════════════════════════════════

app.get("/api/maps", async (req, res) => {
  try {
    const list = await MapModel.find({}, "mapId name author icon category tags plays rating questions").lean();
    res.json(list.map(m => ({ id: m.mapId, name: m.name, author: m.author, icon: m.icon, category: m.category, tags: m.tags, questionCount: m.questions.length, plays: m.plays, rating: m.rating })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/maps/mine", authMiddleware, async (req, res) => {
  try {
    const list = await MapModel.find(
      { $or: [{ authorId: req.user.id }, { author: req.user.username }] },
      "mapId name icon category tags plays rating author authorId createdAt questions"
    ).lean();
    res.json(list.map(m => ({ id: m.mapId, name: m.name, icon: m.icon, category: m.category, tags: m.tags, questionCount: m.questions.length, plays: m.plays, rating: m.rating, author: m.author, createdAt: m.createdAt })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/maps/full/:id", authMiddleware, async (req, res) => {
  try {
    const m = await MapModel.findOne({ mapId: req.params.id }).lean();
    if (!m) return res.status(404).json({ error: "맵을 찾을 수 없습니다" });
    const isOwner = (m.authorId && m.authorId === req.user.id) || m.author === req.user.username;
    if (!isOwner) return res.status(403).json({ error: "이 맵의 수정 권한이 없습니다" });
    res.json({ ...m, id: m.mapId });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/maps/:id", async (req, res) => {
  try {
    const m = await MapModel.findOne({ mapId: req.params.id }).lean();
    if (!m) return res.status(404).json({ error: "맵을 찾을 수 없습니다" });
    res.json({ id: m.mapId, name: m.name, author: m.author, icon: m.icon, category: m.category, tags: m.tags, questions: m.questions.map(q => ({ id: q.id, type: q.type, hint: q.hint, timeLimit: q.timeLimit })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/maps", authMiddleware, async (req, res) => {
  try {
    const { name, icon, category, tags, questions } = req.body;
    if (!name || !questions || questions.length === 0) return res.status(400).json({ error: "맵 이름과 최소 1개의 문제가 필요합니다" });
    const mapId = "map-" + uuidv4().slice(0, 8);
    const map = await MapModel.create({ mapId, name, author: req.user.username, authorId: req.user.id, icon: icon || "🎵", category: category || "anime-song", tags: tags || [], questions: normalizeQuestions(questions) });
    res.json({ id: mapId, message: "맵이 생성되었습니다!" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put("/api/maps/:id", authMiddleware, async (req, res) => {
  try {
    const m = await MapModel.findOne({ mapId: req.params.id });
    if (!m) return res.status(404).json({ error: "맵을 찾을 수 없습니다" });
    const isOwner = (m.authorId && m.authorId === req.user.id) || m.author === req.user.username;
    if (!isOwner) return res.status(403).json({ error: "수정 권한이 없습니다" });
    const { name, icon, category, tags, questions } = req.body;
    if (name) m.name = name;
    if (icon) m.icon = icon;
    if (category) m.category = category;
    if (tags) m.tags = tags;
    if (questions && questions.length > 0) m.questions = normalizeQuestions(questions);
    await m.save();
    res.json({ message: "맵이 수정되었습니다!" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/maps/:id", authMiddleware, async (req, res) => {
  try {
    const m = await MapModel.findOne({ mapId: req.params.id });
    if (!m) return res.status(404).json({ error: "맵을 찾을 수 없습니다" });
    const isOwner2 = (m.authorId && m.authorId === req.user.id) || m.author === req.user.username;
    if (!isOwner2) return res.status(403).json({ error: "삭제 권한이 없습니다" });
    await MapModel.deleteOne({ mapId: req.params.id });
    res.json({ message: "맵이 삭제되었습니다!" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/ranking", async (req, res) => {
  try { res.json(await RankingModel.find().sort({ score: -1 }).limit(100).lean()); }
  catch (e) { res.status(500).json({ error: e.message }); }
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
  res.status(500).json({ error: err.message || "서버 오류" });
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

io.on("connection", (socket) => {
  onlineCount++;
  io.emit("onlineCount", onlineCount);
  console.log(`[+] ${socket.id} (온라인: ${onlineCount})`);

  socket.on("register", ({ name, avatar, userId }) => {
    users.set(socket.id, { id: socket.id, name: name || "Player_" + Math.floor(Math.random() * 9999), avatar: avatar || "🦊", score: 0, userId: userId || name });
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
      const list = await MapModel.find({}, "mapId name author icon category tags plays rating questions").lean();
      socket.emit("mapList", list.map(m => ({ id: m.mapId, name: m.name, author: m.author, icon: m.icon, category: m.category, tags: m.tags, questionCount: m.questions.length, plays: m.plays, rating: m.rating })));
    } catch { socket.emit("mapList", []); }
  });

  socket.on("createRoom", async ({ name, mapId, maxPlayers, password }) => {
    const user = users.get(socket.id);
    if (!user) return socket.emit("error", "먼저 등록해주세요");
    try {
      const map = await MapModel.findOne({ mapId }).lean();
      if (!map) return socket.emit("error", "맵을 찾을 수 없습니다");
      const roomId = "room-" + uuidv4().slice(0, 8);
      const room = createRoom(roomId, name, socket.id, user.name, user.avatar, mapId, maxPlayers, password);
      room.map = map;
      room.players.set(socket.id, { ...user, score: 0, answeredSubQs: new Set() });
      rooms.set(roomId, room);
      socket.join(roomId);
      socket.emit("roomJoined", getRoomState(room));
      broadcastRoomList();
    } catch (e) { socket.emit("error", "방 생성 실패: " + e.message); }
  });

  socket.on("joinRoom", ({ roomId, password }) => {
    const user = users.get(socket.id);
    if (!user) return socket.emit("error", "먼저 등록해주세요");
    const room = rooms.get(roomId);
    if (!room) return socket.emit("error", "방을 찾을 수 없습니다");
    if (room.status !== "waiting") return socket.emit("error", "이미 게임이 진행 중입니다");
    if (room.players.size >= room.maxPlayers) return socket.emit("error", "방이 가득 찼습니다");
    if (room.password && room.password !== (password || "")) return socket.emit("error", "비밀번호가 틀렸습니다", { roomId });
    room.players.set(socket.id, { ...user, score: 0, answeredSubQs: new Set() });
    socket.join(roomId);
    socket.emit("roomJoined", getRoomState(room));
    io.to(roomId).emit("playerJoined", { player: { id: socket.id, name: user.name, avatar: user.avatar }, players: getPlayersArray(room) });
    broadcastRoomList();
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
      room.players.forEach(p => { p.score = 0; p.answeredSubQs = new Set(); });
      await MapModel.updateOne({ mapId: room.mapId }, { $inc: { plays: 1 } });
      io.to(roomId).emit("gameStarted", { totalQuestions: map.questions.length, players: getPlayersArray(room) });
      sendQuestion(room);
      broadcastRoomList();
    } catch (e) { socket.emit("error", "게임 시작 실패: " + e.message); }
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
        io.to(roomId).emit("chatMessage", { type: "system", text: "✅ 모든 플레이어가 완료!" });
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
    const votes = room.skipVoters.size;
    const total = room.players.size;
    // 1~2명: 전원 스킵, 3명 이상: 과반수 (4명→3명, 5명→3명, 6명→4명...)
    const needed = total >= 3 ? Math.floor(total / 2) + 1 : total;
    io.to(roomId).emit("skipVoteUpdate", { votes, total, needed });

    if (votes >= needed) {
      clearInterval(room.timer);
      // 미답 서브퀴즈 정답 공개
      const revealList = subQs.map((sq, i) => ({ prompt: sq.prompt || `문제${i+1}`, answer: sq.showAnswer !== false ? ((sq.answers || [])[0] || "?") : null, answered: room.answeredSubQs.has(i) }));
      io.to(roomId).emit("timeUp", { revealList, scores: getScoresArray(room) });
      const unanswered = revealList.filter(r => !r.answered).map(r => `${r.prompt}: ${r.answer}`).join(", ");
      io.to(roomId).emit("chatMessage", { type: "system", text: `⏭ 스킵! 정답: ${unanswered}` });
      setTimeout(() => nextQuestion(room), 2000);
    }
  });

  socket.on("chat", ({ roomId, message }) => {
    const user = users.get(socket.id);
    if (!user || !message.trim()) return;
    const msg = message.trim();
    const room = rooms.get(roomId);

    // 게임 중이면 정답 체크 먼저
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
            io.to(roomId).emit("chatMessage", { type: "system", text: "✅ 모든 플레이어가 완료!" });
            setTimeout(() => nextQuestion(room), 1500);
          }
          return; // 정답이면 채팅으로 안 보냄
        }
      }
    }

    // 정답 아니면 일반 채팅
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
      const revealList = subQs.map((sq, i) => ({ prompt: sq.prompt || `문제${i+1}`, answer: sq.showAnswer !== false ? ((sq.answers || [])[0] || "?") : null, answered: room.answeredSubQs.has(i) }));
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
    if (!room.players.has(socket.id)) return;
    room.players.delete(socket.id);
    socket.leave(roomId);
    const user = users.get(socket.id);
    io.to(roomId).emit("playerLeft", { playerId: socket.id, playerName: user?.name || "???", players: getPlayersArray(room) });
    io.to(roomId).emit("chatMessage", { type: "system", text: `${user?.name || "???"} 님이 나갔습니다.` });
    if (room.players.size === 0) { clearInterval(room.timer); rooms.delete(roomId); }
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
  })));
}

// ═══════════════════════════════════════════
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
