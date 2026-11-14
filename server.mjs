// AIアートインポスター 本番形サーバー（依存なし・Node 18+）
// 環境変数: FLOYO_API_KEY（必須）, PORT（任意）
// ルームはメモリ保持。フェーズ進行はサーバのタイマーが自律駆動する。
import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const FLOYO_KEY = process.env.FLOYO_API_KEY || "";
const FLOYO_API = "https://api.floyo.ai";
const WRITING_MS = 90_000;
const VOTING_MS = 60_000;
const COMEBACK_MS = 30_000;
const PRESENT_MS = Number(process.env.PRESENT_MS || 60_000); // 絵を1枚ずつ見せる時間（2026-11-14、ユーザー指定で約1分）
const presentScreens = (room) => room.gallery.length;
function enterVoting(room) {
  room.phase = "voting";
  room.phaseStartedAt = Date.now();
  for (const p of room.players) {
    if (!p.isBot) continue;
    setTimeout(() => {
      if (room.phase !== "voting" || room.votes.has(p.id)) return;
      const targets = room.gallery.filter((id) => id !== p.id);
      room.votes.set(p.id, targets[Math.floor(Math.random() * targets.length)]);
      if (room.votes.size >= room.players.length) reveal(room);
    }, 2000 + Math.random() * 5000);
  }
}
function advancePresent(room) {
  room.presentIdx += 1;
  room.presentStartedAt = Date.now();
  if (room.presentIdx >= presentScreens(room)) enterVoting(room);
}
const foldKana = (s) => String(s || "").trim().replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
// 絵のタッチ（プレイヤーごとに選べる。「free」は本人が指示文で表現するので何も付けない）
const STYLES = {
  storybook: ", whimsical storybook illustration, warm colors",
  anime: ", anime style, cel shading, vibrant colors",
  watercolor: ", watercolor painting, soft washes, gentle colors",
  oil: ", oil painting, rich impasto texture",
  pixel: ", pixel art, retro game style",
  photo: ", photorealistic photo, natural light",
  free: "",
};
const STYLE_LABELS = {
  storybook: "絵本", anime: "アニメ", watercolor: "水彩", oil: "油絵",
  pixel: "ドット絵", photo: "写真風", free: "自分で表現",
};

// お題デッキ（2026-11-14 ユーザー指示でシンプル化：短い一場面ワード、ジャンル別）
// 追加はこの配列に足して再デプロイするだけ。
const GENRES = {
  "場所": ["パン屋", "図書館", "温泉", "水族館", "神社"],
  "動物": ["猫カフェ", "ペンギン", "馬", "フクロウ", "金魚"],
  "季節・行事": ["夏祭り", "ハロウィン", "クリスマス", "花見", "雪山"],
  "食べ物": ["ラーメン屋", "パフェ", "寿司", "駄菓子屋", "屋台"],
  "ファンタジー": ["魔法学校", "海賊船", "ドラゴン", "宇宙", "吸血鬼"],
};
const TOPICS = Object.values(GENRES).flat();

const workflowTpl = JSON.parse(await readFile(path.join(__dir, "workflow.json"), "utf8"));

const rooms = new Map();
const codeChars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const newCode = () => {
  let c = "";
  for (let i = 0; i < 5; i++) c += codeChars[Math.floor(Math.random() * codeChars.length)];
  return rooms.has(c) ? newCode() : c;
};
const shuffle = (a) => {
  const x = [...a];
  for (let i = x.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [x[i], x[j]] = [x[j], x[i]];
  }
  return x;
};

function makeRoom(hostName, totalRounds, withBots, genre) {
  const room = {
    code: newCode(),
    phase: "lobby",
    round: 0,
    genre: GENRES[genre] ? genre : "全部",
    totalRounds: Math.min(5, Math.max(1, totalRounds || 3)),
    players: [],
    topic: null,
    usedTopics: [],
    impostorId: null,
    phaseStartedAt: Date.now(),
    submissions: new Map(), // playerId -> {prompt, isFallback, runId, imageUrl, status}
    votes: new Map(), // voterId -> targetPlayerId
    gallery: [], // shuffled playerIds for display
    lastResult: null,
  };
  const host = addPlayer(room, hostName, false);
  room.hostId = host.id;
  if (withBots) {
    addPlayer(room, "ダミー・ミケ", true);
    addPlayer(room, "ダミー・ポチ", true);
  }
  rooms.set(room.code, room);
  return { room, host };
}

function addPlayer(room, name, isBot) {
  const p = {
    id: "p" + Math.random().toString(36).slice(2, 10),
    name: String(name || "ななし").slice(0, 12),
    isBot: !!isBot,
    score: 0,
  };
  room.players.push(p);
  return p;
}

function startRound(room) {
  room.round += 1;
  const deck = room.genre && GENRES[room.genre] ? GENRES[room.genre] : TOPICS;
  let pool = deck.filter((t) => !room.usedTopics.includes(t));
  if (!pool.length) pool = deck;
  room.topic = pool[Math.floor(Math.random() * pool.length)];
  room.usedTopics.push(room.topic);
  room.impostorId = room.players[Math.floor(Math.random() * room.players.length)].id;
  room.submissions = new Map();
  room.votes = new Map();
  room.gallery = [];
  room.phase = "writing";
  room.phaseStartedAt = Date.now();
  // Bots submit after a short delay with topic-blind or topic-aware prompts.
  for (const p of room.players) {
    if (!p.isBot) continue;
    const delay = 3000 + Math.random() * 8000;
    setTimeout(() => {
      if (room.phase !== "writing" || room.submissions.has(p.id)) return;
      const aware = p.id !== room.impostorId;
      const prompt = aware
        ? `${room.topic}の情景、賑やかで楽しい雰囲気`
        : `港町の朝市、活気のある風景`;
      room.submissions.set(p.id, { prompt, isFallback: false, status: "queued" });
      maybeGenerate(room);
    }, delay);
  }
}

// おまかせ（未提出・スキップ）用の自動指示文。
// 市民にはお題ベースでよいが、インポスターにお題を渡すと答えが漏れるため、
// インポスターにはお題を含まない汎用の情景をランダムに渡す（2026-11-14修正）。
const GENERIC_FALLBACKS = [
  "港町の朝市、活気のある風景",
  "緑の多い公園、休日の昼下がり",
  "商店街の夕方、買い物客でにぎわう通り",
  "川辺の散歩道、のどかな風景",
  "山のふもとの小さな駅、静かなホーム",
  "海辺の遊歩道、晴れた日の光",
];
function fallbackPrompt(room, playerId) {
  if (playerId && playerId === room.impostorId) {
    return GENERIC_FALLBACKS[Math.floor(Math.random() * GENERIC_FALLBACKS.length)];
  }
  return `${room.topic}の風景、明るい昼の光`;
}

function maybeGenerate(room) {
  if (room.phase !== "writing") return;
  if (room.submissions.size < room.players.length) return;
  beginGeneration(room);
}

async function floyo(pathname, options = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${FLOYO_API}${pathname}`, {
        ...options,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${FLOYO_KEY}`,
          ...(options.headers || {}),
        },
      });
      if (res.status >= 500) throw new Error(`Floyo ${res.status}`);
      if (!res.ok) throw new Error(`Floyo ${res.status}: ${await res.text().then((t) => t.slice(0, 200))}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      if (attempt < 2) await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
  throw lastErr;
}

async function generateFor(room, playerId, sub) {
  sub.status = "generating";
  try {
    const wf = JSON.parse(JSON.stringify(workflowTpl.workflow));
    wf["66:64"].inputs.text = `${sub.prompt}${STYLES[sub.style] ?? STYLES.storybook}`;
    wf["66:65"].inputs.seed = Math.floor(Math.random() * 2 ** 31);
    const created = await floyo("/runs", {
      method: "POST",
      body: JSON.stringify({ name: "Impostor Game", workflow: wf }),
    });
    sub.runId = created.id;
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5000));
      const detail = await floyo(`/runs/${sub.runId}?expand=outputs.presigned_url&presigned_url_expires_in=3600`);
      if (detail.status === "complete") {
        // Outputs can lag a moment behind the status flip; re-fetch a few times.
        let out = (detail.outputs || [])[0];
        for (let i = 0; i < 5 && !(out && out.presigned_url); i++) {
          await new Promise((r) => setTimeout(r, 4000));
          const again = await floyo(`/runs/${sub.runId}?expand=outputs.presigned_url&presigned_url_expires_in=3600`);
          out = (again.outputs || [])[0];
        }
        sub.imageUrl = out ? out.presigned_url || null : null;
        if (sub.imageUrl) { sub.status = "done"; return; }
        // URLの到着が遅れているだけのことがある。諦めず裏で取り直し続ける
        // （届いた時点で画面の次の更新から表示される）。
        sub.status = "resolving";
        resolveLater(sub);
        return;
      }
      if (["failed", "error", "cancelled"].includes(detail.status)) {
        sub.status = "failed";
        return;
      }
    }
    sub.status = "failed";
  } catch (e) {
    console.error("generation failed:", e.message);
    sub.status = "failed";
  }
}

// 生成は終わったのに画像URLだけ遅れている場合の裏側リトライ（最大約5分）。
async function resolveLater(sub) {
  for (let i = 0; i < 30 && !sub.imageUrl; i++) {
    await new Promise((r) => setTimeout(r, 10_000));
    try {
      const again = await floyo(`/runs/${sub.runId}?expand=outputs.presigned_url&presigned_url_expires_in=3600`);
      const out = (again.outputs || [])[0];
      if (out?.presigned_url) { sub.imageUrl = out.presigned_url; sub.status = "done"; return; }
    } catch { /* keep trying */ }
  }
  if (!sub.imageUrl) sub.status = "failed";
}

function beginGeneration(room) {
  room.phase = "generating";
  room.phaseStartedAt = Date.now();
  const jobs = [...room.submissions.entries()].map(([pid, sub]) => generateFor(room, pid, sub));
  Promise.allSettled(jobs).then(() => {
    if (room.phase !== "generating") return;
    room.gallery = shuffle([...room.submissions.keys()]);
    // いきなり全員分を並べず、1枚ずつ見せてから投票に入る。
    room.phase = "presenting";
    room.phaseStartedAt = Date.now();
    room.presentIdx = 0;
    room.presentStartedAt = Date.now();
  });
}

// 投票の締め。当たっていたら即確定、外れていたらインポスターの「逆転当て」フェーズへ（2026-11-14追加）。
function reveal(room) {
  const tally = new Map();
  for (const t of room.votes.values()) tally.set(t, (tally.get(t) || 0) + 1);
  const impVotes = tally.get(room.impostorId) || 0;
  const maxVotes = Math.max(0, ...tally.values());
  const caught = impVotes > 0 && impVotes >= maxVotes;
  room.pendingTally = Object.fromEntries(tally);
  if (!caught) {
    const gained = {};
    const imp = room.players.find((p) => p.id === room.impostorId);
    if (imp) { imp.score += 3; gained[room.impostorId] = 3; }
    room.lastResult = { tally: room.pendingTally, caught, gained };
    room.phase = "reveal";
    room.phaseStartedAt = Date.now();
    return;
  }
  // 的中 → 逆転当てフェーズ（インポスターがお題を当てれば勝ちがひっくり返る）
  room.phase = "comeback";
  room.phaseStartedAt = Date.now();
  const imp = room.players.find((p) => p.id === room.impostorId);
  if (imp?.isBot) {
    setTimeout(() => {
      if (room.phase !== "comeback") return;
      finishComeback(room, TOPICS[Math.floor(Math.random() * TOPICS.length)]);
    }, 4000);
  }
}

function finishComeback(room, guess) {
  const success = !!guess && foldKana(guess) === foldKana(room.topic);
  const gained = {};
  if (success) {
    const imp = room.players.find((p) => p.id === room.impostorId);
    if (imp) { imp.score += 3; gained[room.impostorId] = 3; }
  } else {
    for (const [voter, target] of room.votes.entries()) {
      if (target === room.impostorId) {
        const pl = room.players.find((p) => p.id === voter);
        if (pl) { pl.score += 2; gained[voter] = 2; }
      }
    }
  }
  room.lastResult = {
    tally: room.pendingTally, caught: true, gained,
    comeback: { guess: guess || null, success },
  };
  room.phase = "reveal";
  room.phaseStartedAt = Date.now();
}

// Server-driven phase advancement (runs regardless of client polling).
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (room.phase === "writing" && now - room.phaseStartedAt > WRITING_MS) {
      for (const p of room.players) {
        if (!room.submissions.has(p.id)) {
          room.submissions.set(p.id, { prompt: fallbackPrompt(room, p.id), isFallback: true, status: "queued" });
        }
      }
      beginGeneration(room);
    } else if (room.phase === "presenting" && now - room.presentStartedAt > PRESENT_MS) {
      advancePresent(room);
    } else if (room.phase === "voting" && now - room.phaseStartedAt > VOTING_MS) {
      reveal(room);
    } else if (room.phase === "comeback" && now - room.phaseStartedAt > COMEBACK_MS) {
      finishComeback(room, null);
    }
  }
}, 1000);

function publicState(room, viewerId) {
  const me = room.players.find((p) => p.id === viewerId);
  const isImpostor = viewerId === room.impostorId;
  const base = {
    code: room.code,
    phase: room.phase,
    round: room.round,
    totalRounds: room.totalRounds,
    genre: room.genre || "全部",
    hostId: room.hostId,
    players: room.players.map((p) => ({ id: p.id, name: p.name, score: p.score, isBot: p.isBot })),
    phaseEndsAt: room.phase === "writing" ? room.phaseStartedAt + WRITING_MS
      : room.phase === "voting" ? room.phaseStartedAt + VOTING_MS
      : room.phase === "comeback" ? room.phaseStartedAt + COMEBACK_MS
      : room.phase === "presenting" ? room.presentStartedAt + PRESENT_MS : null,
    submittedCount: room.submissions.size,
    playerCount: room.players.length,
    mySubmitted: room.submissions.has(viewerId),
    myVote: room.votes.get(viewerId) || null,
  };
  if (["writing", "generating", "presenting", "voting", "comeback", "reveal"].includes(room.phase)) {
    base.topic = isImpostor ? null : room.topic;
    base.youAreImpostor = isImpostor;
  }
  if (room.phase === "presenting") {
    const idx = room.presentIdx || 0;
    const pid = room.gallery[idx];
    base.present = {
      screen: idx,
      screens: presentScreens(room),
      from: idx + 1,
      to: idx + 1,
      totalImages: room.gallery.length,
      isHost: viewerId === room.hostId,
      items: [{
        imageUrl: room.submissions.get(pid)?.imageUrl || null,
        isMine: pid === viewerId,
      }],
    };
  }
  if (room.phase === "voting" || room.phase === "comeback" || room.phase === "reveal") {
    base.gallery = room.gallery.map((pid) => ({
      playerId: pid,
      imageUrl: room.submissions.get(pid)?.imageUrl || null,
    }));
  }
  if (room.phase === "reveal") {
    base.topic = room.topic;
    base.impostorId = room.impostorId;
    base.result = room.lastResult;
    base.entries = room.gallery.map((pid) => ({
      playerId: pid,
      name: room.players.find((p) => p.id === pid)?.name,
      prompt: room.submissions.get(pid)?.prompt,
      styleLabel: STYLE_LABELS[room.submissions.get(pid)?.style] || "絵本",
      isFallback: room.submissions.get(pid)?.isFallback,
      imageUrl: room.submissions.get(pid)?.imageUrl || null,
      votes: room.lastResult?.tally?.[pid] || 0,
    }));
  }
  if (room.phase === "finished") {
    base.standings = [...room.players].sort((a, b) => b.score - a.score)
      .map((p) => ({ id: p.id, name: p.name, score: p.score }));
  }
  return base;
}

function json(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}
async function bodyJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  try { return JSON.parse(Buffer.concat(chunks).toString() || "{}"); } catch { return {}; }
}

const indexHtml = await readFile(path.join(__dir, "public", "index.html"), "utf8");

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const parts = url.pathname.split("/").filter(Boolean);
  try {
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(indexHtml);
    }
    if (req.method === "GET" && url.pathname === "/health") return json(res, 200, { ok: true, floyo: !!FLOYO_KEY });

    if (parts[0] === "api" && parts[1] === "rooms") {
      if (req.method === "POST" && parts.length === 2) {
        const b = await bodyJson(req);
        const { room, host } = makeRoom(b.name, b.totalRounds, b.withBots, b.genre);
        return json(res, 200, { code: room.code, playerId: host.id });
      }
      const code = (parts[2] || "").toUpperCase();
      const room = rooms.get(code);
      if (!room) return json(res, 404, { error: "ルームが見つかりません" });
      if (req.method === "POST" && parts[3] === "join") {
        const b = await bodyJson(req);
        if (room.phase !== "lobby") return json(res, 400, { error: "すでに始まっています" });
        const p = addPlayer(room, b.name, false);
        return json(res, 200, { code: room.code, playerId: p.id });
      }
      if (req.method === "GET" && parts[3] === "state") {
        return json(res, 200, publicState(room, url.searchParams.get("player") || ""));
      }
      if (req.method === "POST" && parts[3] === "start") {
        const b = await bodyJson(req);
        if (b.playerId !== room.hostId) return json(res, 403, { error: "ホストだけが開始できます" });
        if (room.phase !== "lobby") return json(res, 400, { error: "開始済みです" });
        if (room.players.length < 3) return json(res, 400, { error: "3人以上で開始できます" });
        startRound(room);
        return json(res, 200, { ok: true });
      }
      if (req.method === "POST" && parts[3] === "submit") {
        const b = await bodyJson(req);
        if (room.phase !== "writing") return json(res, 400, { error: "提出フェーズではありません" });
        if (!room.players.some((p) => p.id === b.playerId)) return json(res, 403, { error: "参加者ではありません" });
        if (room.submissions.has(b.playerId)) return json(res, 400, { error: "提出済みです" });
        const prompt = b.skip ? fallbackPrompt(room, b.playerId) : String(b.prompt || "").slice(0, 200).trim();
        if (!prompt) return json(res, 400, { error: "指示文が空です" });
        if (!b.skip) {
          // ルール（2026-11-14）：お題の言葉はそのまま書けない。カタカナ→ひらがなに寄せても判定する。
          const kataToHira = (s) => s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
          if (prompt.includes(room.topic) || kataToHira(prompt).includes(kataToHira(room.topic))) {
            return json(res, 400, { error: "お題の言葉はそのまま書けません。様子を別の言葉で表してみてください" });
          }
        }
        const style = STYLES[b.style] !== undefined ? b.style : "storybook";
        room.submissions.set(b.playerId, { prompt, isFallback: !!b.skip, status: "queued", style });
        maybeGenerate(room);
        return json(res, 200, { ok: true });
      }
      if (req.method === "POST" && parts[3] === "vote") {
        const b = await bodyJson(req);
        if (room.phase !== "voting") return json(res, 400, { error: "投票フェーズではありません" });
        if (b.targetPlayerId === b.playerId) return json(res, 400, { error: "自分の絵には投票できません" });
        if (!room.submissions.has(b.targetPlayerId)) return json(res, 400, { error: "対象がありません" });
        room.votes.set(b.playerId, b.targetPlayerId);
        if (room.votes.size >= room.players.length) reveal(room);
        return json(res, 200, { ok: true });
      }
      if (req.method === "POST" && parts[3] === "present-next") {
        const b = await bodyJson(req);
        if (room.phase !== "presenting") return json(res, 400, { error: "絵の表示フェーズではありません" });
        if (b.playerId !== room.hostId) return json(res, 403, { error: "ホストだけが進められます" });
        advancePresent(room);
        return json(res, 200, { ok: true });
      }
      if (req.method === "POST" && parts[3] === "comeback") {
        const b = await bodyJson(req);
        if (room.phase !== "comeback") return json(res, 400, { error: "逆転当てフェーズではありません" });
        if (b.playerId !== room.impostorId) return json(res, 403, { error: "インポスターだけが答えられます" });
        finishComeback(room, String(b.guess || "").slice(0, 30));
        return json(res, 200, { ok: true });
      }
      if (req.method === "POST" && parts[3] === "next") {
        const b = await bodyJson(req);
        if (b.playerId !== room.hostId) return json(res, 403, { error: "ホストだけが進められます" });
        if (room.phase !== "reveal") return json(res, 400, { error: "公開フェーズではありません" });
        if (room.round >= room.totalRounds) { room.phase = "finished"; }
        else startRound(room);
        return json(res, 200, { ok: true });
      }
    }
    return json(res, 404, { error: "not found" });
  } catch (e) {
    console.error(e);
    return json(res, 500, { error: "server error" });
  }
});

server.listen(PORT, () => console.log(`impostor-game listening on :${PORT} (floyo key: ${FLOYO_KEY ? "set" : "MISSING"})`));
