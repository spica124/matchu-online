// ═══════════════════════════════════════════════════════════════
// 마추기온라인.io — Server (Express + Socket.IO)
// ═══════════════════════════════════════════════════════════════

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const { v4: uuidv4 } = require("uuid");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
  pingTimeout: 60000,
  pingInterval: 25000,
});

// ── Static files ──
app.use(express.static(path.join(__dirname, "../public")));
app.use(express.json());

// ═══════════════════════════════════════════
// In-Memory Data Store
// (프로덕션에서는 Redis나 DB 사용 권장)
// ═══════════════════════════════════════════

const users = new Map();      // socketId → { id, name, avatar, score }
const rooms = new Map();      // roomId → Room object
const maps = new Map();       // mapId → Map object
let onlineCount = 0;
const globalRanking = [];     // 글로벌 랭킹 (상위 100개 유지)

// 예시 맵 없음 — 사용자가 직접 제작

// ═══════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════

function getChosung(str) {
  const CS = ['ㄱ','ㄲ','ㄴ','ㄷ','ㄸ','ㄹ','ㅁ','ㅂ','ㅃ','ㅅ','ㅆ','ㅇ','ㅈ','ㅉ','ㅊ','ㅋ','ㅌ','ㅍ','ㅎ'];
  return str.split('').map(ch => {
    const code = ch.charCodeAt(0) - 0xAC00;
    if (code >= 0 && code <= 11171) return CS[Math.floor(code / 588)];
    return ch === ' ' ? ' ' : ch;
  }).join('');
}

// ═══════════════════════════════════════════
// Room Class
// ═══════════════════════════════════════════

function createRoom(id, name, hostId, hostName, hostAvatar, mapId, maxPlayers) {
  return {
    id,
    name,
    hostId,
    hostName: hostName,
    hostAvatar,
    mapId,
    maxPlayers: Math.min(Math.max(maxPlayers, 1), 8),
    players: new Map(), // socketId → { id, name, avatar, score, answered }
    status: "waiting",  // waiting | playing | finished
    currentQuestion: 0,
    answerOrder: [],     // 정답 맞춘 순서
    skipVoters: new Set(), // 스킵 투표한 socketId
    timer: null,
    timeLeft: 0,
    createdAt: Date.now(),
  };
}

// ═══════════════════════════════════════════
// REST API
// ═══════════════════════════════════════════

// 맵 목록
app.get("/api/maps", (req, res) => {
  const list = Array.from(maps.values()).map((m) => ({
    id: m.id,
    name: m.name,
    author: m.author,
    icon: m.icon,
    category: m.category,
    tags: m.tags,
    questionCount: m.questions.length,
    plays: m.plays,
    rating: m.rating,
  }));
  res.json(list);
});

// 맵 상세
app.get("/api/maps/:id", (req, res) => {
  const m = maps.get(req.params.id);
  if (!m) return res.status(404).json({ error: "맵을 찾을 수 없습니다" });
  res.json({
    ...m,
    questions: m.questions.map((q) => ({
      id: q.id,
      type: q.type,
      hint: q.hint,
      timeLimit: q.timeLimit,
      // 정답은 서버에서만 보관
    })),
  });
});

// 맵 전체 데이터 (수정용 — authorId 본인만)
app.get("/api/maps/full/:id", (req, res) => {
  const m = maps.get(req.params.id);
  if (!m) return res.status(404).json({ error: "맵을 찾을 수 없습니다" });
  const { authorId } = req.query;
  if (m.authorId && m.authorId !== authorId) return res.status(403).json({ error: "권한 없음" });
  res.json(m); // 정답 포함 전체 반환
});

// 내 맵 목록
app.get("/api/maps/mine/:authorId", (req, res) => {
  const { authorId } = req.params;
  const list = Array.from(maps.values())
    .filter(m => m.authorId === authorId)
    .map(m => ({
      id: m.id, name: m.name, icon: m.icon, category: m.category,
      tags: m.tags, questionCount: m.questions.length, plays: m.plays,
      rating: m.rating, author: m.author, createdAt: m.createdAt,
    }));
  res.json(list);
});

// 맵 수정 (authorId 검증)
app.put("/api/maps/:id", (req, res) => {
  const m = maps.get(req.params.id);
  if (!m) return res.status(404).json({ error: "맵을 찾을 수 없습니다" });
  if (m.authorId && m.authorId !== req.body.authorId) return res.status(403).json({ error: "수정 권한이 없습니다" });

  const { name, icon, category, tags, questions } = req.body;
  if (name) m.name = name;
  if (icon) m.icon = icon;
  if (category) m.category = category;
  if (tags) m.tags = tags;
  if (questions && questions.length > 0) {
    m.questions = questions.map((q, i) => {
      let answers;
      if (Array.isArray(q.answers)) {
        answers = q.answers.map(a => a.toLowerCase().trim()).filter(Boolean);
      } else {
        answers = (q.answers || q.answer || "").split(",").map(a => a.toLowerCase().trim()).filter(Boolean);
      }
      if (!answers.length) answers = [""];
      return {
        id: i + 1, type: q.type || "audio", hint: q.hint || "", answers,
        anime: q.anime || "", timeLimit: q.timeLimit || 30,
        mediaUrl: q.mediaUrl || "", startTime: parseInt(q.startTime) || 0,
        endTime: parseInt(q.endTime) || 0, chosungHint: !!q.chosungHint,
        hintRevealTime: parseInt(q.hintRevealTime) || 0,
      };
    });
  }
  res.json({ message: "맵이 수정되었습니다!" });
});

// 맵 삭제 (authorId 검증)
app.delete("/api/maps/:id", (req, res) => {
  const m = maps.get(req.params.id);
  if (!m) return res.status(404).json({ error: "맵을 찾을 수 없습니다" });
  const { authorId } = req.body;
  if (m.authorId && m.authorId !== authorId) return res.status(403).json({ error: "삭제 권한이 없습니다" });
  maps.delete(req.params.id);
  res.json({ message: "맵이 삭제되었습니다!" });
});

// 맵 생성
app.post("/api/maps", (req, res) => {
  const { name, author, authorId, icon, category, tags, questions } = req.body;
  if (!name || !questions || questions.length === 0) {
    return res.status(400).json({ error: "맵 이름과 최소 1개의 문제가 필요합니다" });
  }
  const id = "map-" + uuidv4().slice(0, 8);
  const map = {
    id,
    name,
    author: author || "익명",
    authorId: authorId || "",
    icon: icon || "🎵",
    category: category || "anime-song",
    tags: tags || [],
    plays: 0,
    rating: 0,
    createdAt: Date.now(),
    questions: questions.map((q, i) => {
      // 복수 정답: answers 배열 또는 answer 문자열(쉼표 구분) 지원
      let answers;
      if (Array.isArray(q.answers)) {
        answers = q.answers.map(a => a.toLowerCase().trim()).filter(Boolean);
      } else {
        const raw = q.answers || q.answer || "";
        answers = raw.split(",").map(a => a.toLowerCase().trim()).filter(Boolean);
      }
      if (answers.length === 0) answers = [""];
      return {
        id: i + 1,
        type: q.type || "audio",
        hint: q.hint || "",
        answers,
        anime: q.anime || "",
        timeLimit: q.timeLimit || 30,
        mediaUrl: q.mediaUrl || "",
        startTime: parseInt(q.startTime) || 0,
        endTime: parseInt(q.endTime) || 0,
        chosungHint: !!q.chosungHint,
        hintRevealTime: parseInt(q.hintRevealTime) || 0,
      };
    }),
  };
  maps.set(id, map);
  res.json({ id, message: "맵이 생성되었습니다!" });
});

// 글로벌 랭킹
app.get("/api/ranking", (req, res) => {
  res.json(globalRanking.slice(0, 100));
});

// 방 목록
app.get("/api/rooms", (req, res) => {
  const list = Array.from(rooms.values()).filter(r => r.status !== "finished").map((r) => ({
    id: r.id,
    name: r.name,
    hostName: r.hostName,
    mapId: r.mapId,
    mapName: maps.get(r.mapId)?.name || "알 수 없음",
    mapIcon: maps.get(r.mapId)?.icon || "❓",
    players: r.players.size,
    maxPlayers: r.maxPlayers,
    status: r.status,
  }));
  res.json(list);
});

// 서버 상태
app.get("/api/status", (req, res) => {
  res.json({
    online: onlineCount,
    rooms: rooms.size,
    maps: maps.size,
  });
});

// SPA fallback
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "../public/index.html"));
});

// ═══════════════════════════════════════════
// Socket.IO — Real-time Game Logic
// ═══════════════════════════════════════════

io.on("connection", (socket) => {
  onlineCount++;
  console.log(`[+] 접속: ${socket.id} (온라인: ${onlineCount})`);

  // 전체 온라인 수 브로드캐스트
  io.emit("onlineCount", onlineCount);

  // ── 유저 등록 ──
  socket.on("register", ({ name, avatar }) => {
    users.set(socket.id, {
      id: socket.id,
      name: name || "Player_" + Math.floor(Math.random() * 9999),
      avatar: avatar || "🦊",
      score: 0,
    });
    socket.emit("registered", users.get(socket.id));
  });

  // ── 방 목록 요청 ──
  socket.on("getRooms", () => {
    const list = Array.from(rooms.values()).map((r) => ({
      id: r.id,
      name: r.name,
      hostName: r.hostName,
      mapId: r.mapId,
      mapName: maps.get(r.mapId)?.name || "알 수 없음",
      mapIcon: maps.get(r.mapId)?.icon || "❓",
      players: r.players.size,
      maxPlayers: r.maxPlayers,
      status: r.status,
    }));
    socket.emit("roomList", list);
  });

  // ── 맵 목록 요청 ──
  socket.on("getMaps", () => {
    const list = Array.from(maps.values()).map((m) => ({
      id: m.id,
      name: m.name,
      author: m.author,
      icon: m.icon,
      category: m.category,
      tags: m.tags,
      questionCount: m.questions.length,
      plays: m.plays,
      rating: m.rating,
    }));
    socket.emit("mapList", list);
  });

  // ── 방 생성 ──
  socket.on("createRoom", ({ name, mapId, maxPlayers }) => {
    const user = users.get(socket.id);
    if (!user) return socket.emit("error", "먼저 등록해주세요");
    if (!maps.has(mapId)) return socket.emit("error", "맵을 찾을 수 없습니다");

    const roomId = "room-" + uuidv4().slice(0, 8);
    const room = createRoom(roomId, name, socket.id, user.name, user.avatar, mapId, maxPlayers);
    room.players.set(socket.id, { ...user, score: 0, answered: false });
    rooms.set(roomId, room);

    socket.join(roomId);
    socket.emit("roomJoined", getRoomState(room));
    broadcastRoomList();

    console.log(`[방 생성] ${name} (${roomId}) by ${user.name}`);
  });

  // ── 방 참가 ──
  socket.on("joinRoom", ({ roomId }) => {
    const user = users.get(socket.id);
    if (!user) return socket.emit("error", "먼저 등록해주세요");

    const room = rooms.get(roomId);
    if (!room) return socket.emit("error", "방을 찾을 수 없습니다");
    if (room.status !== "waiting") return socket.emit("error", "이미 게임이 진행 중입니다");
    if (room.players.size >= room.maxPlayers) return socket.emit("error", "방이 가득 찼습니다");

    room.players.set(socket.id, { ...user, score: 0, answered: false });
    socket.join(roomId);

    socket.emit("roomJoined", getRoomState(room));
    io.to(roomId).emit("playerJoined", {
      player: { id: socket.id, name: user.name, avatar: user.avatar },
      players: getPlayersArray(room),
    });
    broadcastRoomList();

    console.log(`[참가] ${user.name} → ${room.name}`);
  });

  // ── 방 나가기 ──
  socket.on("leaveRoom", () => {
    leaveAllRooms(socket);
  });

  // ── 게임 시작 (호스트만) ──
  socket.on("startGame", ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    if (room.hostId !== socket.id) return socket.emit("error", "호스트만 시작할 수 있습니다");
    if (room.players.size < 1) return socket.emit("error", "최소 1명이 필요합니다");

    const map = maps.get(room.mapId);
    if (!map) return socket.emit("error", "맵 데이터를 찾을 수 없습니다");

    room.status = "playing";
    room.currentQuestion = 0;
    room.answerOrder = [];

    // 모든 플레이어 점수 초기화
    room.players.forEach((p, sid) => {
      p.score = 0;
      p.answered = false;
    });

    // 맵 플레이 수 증가
    map.plays++;

    io.to(roomId).emit("gameStarted", {
      totalQuestions: map.questions.length,
      players: getPlayersArray(room),
    });

    // 첫 문제 전송
    sendQuestion(room);
    broadcastRoomList();

    console.log(`[게임 시작] ${room.name} (${map.questions.length}문제)`);
  });

  // ── 정답 제출 ──
  socket.on("submitAnswer", ({ roomId, answer }) => {
    const room = rooms.get(roomId);
    if (!room || room.status !== "playing") return;

    const player = room.players.get(socket.id);
    if (!player || player.answered) return;

    const map = maps.get(room.mapId);
    if (!map) return;

    const question = map.questions[room.currentQuestion];
    if (!question) return;

    const normalizedAnswer = answer.toLowerCase().trim();
    const correctAnswers = question.answers || [question.answer || ""];
    const isCorrect = correctAnswers.some(a => a.toLowerCase().trim() === normalizedAnswer);

    // 본인에게만 입력 내용 표시 (다른 플레이어에게는 숨김)
    socket.emit("chatMessage", {
      type: "answer",
      name: player.name,
      text: answer,
    });

    if (isCorrect) {
      player.answered = true;
      room.answerOrder.push(socket.id);

      // 순서 기반 점수: 인원수 - (순서-1) = 8명이면 1등 8점, 2등 7점, 1명이면 1점
      const order = room.answerOrder.length;
      const points = Math.max(1, room.players.size - order + 1);

      player.score += points;

      // 정답 알림
      io.to(roomId).emit("correctAnswer", {
        playerId: socket.id,
        playerName: player.name,
        points,
        order,
        scores: getScoresArray(room),
      });

      io.to(roomId).emit("chatMessage", {
        type: "correct",
        text: `${player.name}님이 ${order}등으로 정답! (+${points}점)`,
      });

      // 전원 정답 시 다음 곡으로
      const allAnswered = Array.from(room.players.values()).every(p => p.answered);
      if (allAnswered) {
        clearInterval(room.timer);
        io.to(roomId).emit("chatMessage", { type: "system", text: "✅ 전원 정답! 다음 문제로 넘어갑니다." });
        setTimeout(() => nextQuestion(room), 2000);
      }
    } else {
      socket.emit("wrongAnswer", { text: "오답!" });
    }
  });

  // ── 스킵 투표 ──
  socket.on("skipVote", ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || room.status !== "playing") return;
    const player = room.players.get(socket.id);
    if (!player) return;
    if (player.answered) return; // 맞춘 사람은 스킵 불가

    room.skipVoters.add(socket.id);

    // 아직 못 맞춘 플레이어만 집계
    const unanswered = Array.from(room.players.values()).filter(p => !p.answered);
    const votes = room.skipVoters.size;
    const total = room.players.size;

    io.to(roomId).emit("skipVoteUpdate", { votes, total, unanswered: unanswered.length });

    // 미정답자 절반 이상이 스킵 투표하면 스킵
    if (votes >= Math.ceil(unanswered.length / 2)) {
      clearInterval(room.timer);
      const map = maps.get(room.mapId);
      const q = map?.questions[room.currentQuestion];
      const revealAnswer = q ? (q.answers || [q.answer || "?"])[0] : "?";
      io.to(roomId).emit("timeUp", {
        answer: revealAnswer,
        answers: q?.answers || [revealAnswer],
        anime: q?.anime || "",
        scores: getScoresArray(room),
      });
      io.to(roomId).emit("chatMessage", { type: "system", text: `⏭ 스킵! 정답: ${revealAnswer}` });
      setTimeout(() => nextQuestion(room), 2000);
    }
  });

  // ── 채팅 ──
  socket.on("chat", ({ roomId, message }) => {
    const user = users.get(socket.id);
    if (!user || !message.trim()) return;
    io.to(roomId).emit("chatMessage", {
      type: "chat",
      name: user.name,
      text: message.trim(),
    });
  });

  // ── 연결 종료 ──
  socket.on("disconnect", () => {
    onlineCount = Math.max(0, onlineCount - 1);
    io.emit("onlineCount", onlineCount);
    leaveAllRooms(socket);
    users.delete(socket.id);
    console.log(`[-] 접속 해제: ${socket.id} (온라인: ${onlineCount})`);
  });
});

// ═══════════════════════════════════════════
// Game Logic Helpers
// ═══════════════════════════════════════════

function sendQuestion(room) {
  const map = maps.get(room.mapId);
  if (!map) return;

  const q = map.questions[room.currentQuestion];
  if (!q) return;

  // 플레이어 answered 리셋
  room.players.forEach((p) => (p.answered = false));
  room.answerOrder = [];
  room.skipVoters = new Set();
  room.timeLeft = q.timeLimit;

  // 문제 전송 (정답 제외)
  io.to(room.id).emit("question", {
    index: room.currentQuestion,
    total: map.questions.length,
    type: q.type,
    hint: q.hint,
    anime: q.anime,
    timeLimit: q.timeLimit,
    mediaUrl: q.mediaUrl || "",
    startTime: q.startTime || 0,
    endTime: q.endTime || 0,
  });

  // 타이머
  clearTimeout(room.timer);
  room.timer = setInterval(() => {
    room.timeLeft--;
    io.to(room.id).emit("timeUpdate", room.timeLeft);

    // 초성 힌트 공개 타이밍
    if (q.chosungHint && q.hintRevealTime > 0) {
      const revealAt = q.timeLimit - q.hintRevealTime;
      if (room.timeLeft === revealAt) {
        const firstAnswer = (q.answers || [q.answer || ""])[0];
        const hint = getChosung(firstAnswer);
        io.to(room.id).emit("hintReveal", { hint });
        io.to(room.id).emit("chatMessage", { type: "system", text: `💡 초성 힌트: ${hint}` });
      }
    }

    if (room.timeLeft <= 0) {
      clearInterval(room.timer);
      // 시간 초과 — 정답 공개
      const revealAnswer = (q.answers || [q.answer || "?"])[0];
      io.to(room.id).emit("timeUp", {
        answer: revealAnswer,
        answers: q.answers || [revealAnswer],
        anime: q.anime,
        scores: getScoresArray(room),
      });

      io.to(room.id).emit("chatMessage", {
        type: "system",
        text: `시간 초과! 정답: ${revealAnswer}`,
      });

      setTimeout(() => nextQuestion(room), 3000);
    }
  }, 1000);
}

function nextQuestion(room) {
  room.currentQuestion++;
  const map = maps.get(room.mapId);

  if (!map || room.currentQuestion >= map.questions.length) {
    // 게임 종료
    room.status = "finished";
    clearInterval(room.timer);

    const finalScores = getScoresArray(room);
    io.to(room.id).emit("gameOver", { scores: finalScores });

    // 글로벌 랭킹 업데이트 — 게임에 참가한 모든 플레이어 기록
    const mapObj = maps.get(room.mapId);
    finalScores.forEach(p => {
      if (p.score > 0) {
        globalRanking.push({
          name: p.name,
          avatar: p.avatar,
          score: p.score,
          mapName: mapObj ? mapObj.name : "알 수 없음",
          date: new Date().toISOString(),
        });
      }
    });
    globalRanking.sort((a, b) => b.score - a.score);
    if (globalRanking.length > 100) globalRanking.splice(100);

    io.to(room.id).emit("chatMessage", {
      type: "system",
      text: "🏆 게임 종료!",
    });

    // 결과 화면 표시 후 3초 뒤 즉시 방 삭제
    setTimeout(() => {
      if (rooms.has(room.id)) {
        clearInterval(room.timer);
        rooms.delete(room.id);
        broadcastRoomList();
        console.log(`[방 삭제] ${room.name} (게임 종료)`);
      }
    }, 3000);

    broadcastRoomList();
    return;
  }

  sendQuestion(room);
}

function leaveAllRooms(socket) {
  rooms.forEach((room, roomId) => {
    if (room.players.has(socket.id)) {
      room.players.delete(socket.id);
      socket.leave(roomId);

      const user = users.get(socket.id);
      io.to(roomId).emit("playerLeft", {
        playerId: socket.id,
        playerName: user?.name || "???",
        players: getPlayersArray(room),
      });

      io.to(roomId).emit("chatMessage", {
        type: "system",
        text: `${user?.name || "???"} 님이 나갔습니다.`,
      });

      // 방이 비면 삭제 (게임 중/종료 무관)
      if (room.players.size === 0) {
        clearInterval(room.timer);
        rooms.delete(roomId);
        console.log(`[방 삭제] ${room.name} (${roomId}) — 플레이어 없음`);
      } else if (room.hostId === socket.id) {
        // 호스트가 나갔으면 다음 사람을 호스트로
        const nextHost = room.players.keys().next().value;
        room.hostId = nextHost;
        const nextUser = room.players.get(nextHost);
        room.hostName = nextUser?.name || "???";
        io.to(roomId).emit("newHost", { hostId: nextHost, hostName: room.hostName });
      }

      broadcastRoomList();
    }
  });
}

function getRoomState(room) {
  const map = maps.get(room.mapId);
  return {
    id: room.id,
    name: room.name,
    hostId: room.hostId,
    hostName: room.hostName,
    mapId: room.mapId,
    mapName: map?.name || "알 수 없음",
    mapIcon: map?.icon || "❓",
    questionCount: map?.questions.length || 0,
    maxPlayers: room.maxPlayers,
    status: room.status,
    players: getPlayersArray(room),
  };
}

function getPlayersArray(room) {
  return Array.from(room.players.entries()).map(([sid, p]) => ({
    id: sid,
    name: p.name,
    avatar: p.avatar,
    score: p.score,
    isHost: sid === room.hostId,
  }));
}

function getScoresArray(room) {
  return Array.from(room.players.values())
    .map((p) => ({ name: p.name, avatar: p.avatar, score: p.score }))
    .sort((a, b) => b.score - a.score);
}

function broadcastRoomList() {
  const list = Array.from(rooms.values())
    .filter(r => r.status !== "finished")
    .map((r) => ({
      id: r.id,
      name: r.name,
      hostName: r.hostName,
      mapId: r.mapId,
      mapName: maps.get(r.mapId)?.name || "알 수 없음",
      mapIcon: maps.get(r.mapId)?.icon || "❓",
      players: r.players.size,
      maxPlayers: r.maxPlayers,
      status: r.status,
    }));
  io.emit("roomList", list);
}

// ═══════════════════════════════════════════
// Start Server
// ═══════════════════════════════════════════

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════╗
║                                           ║
║   🎯 마추기온라인.io 서버 시작!           ║
║                                           ║
║   http://localhost:${PORT}                  ║
║                                           ║
║   온라인 퀴즈 배틀을 시작하세요!          ║
║                                           ║
╚═══════════════════════════════════════════╝
  `);
});
