"use strict";

/* =========================================================
   聞き流し論証 プレイヤー(iPhone Safari / PWA)
   - PC側で生成したパック(.kkpack)を取り込み、IndexedDBに保存して
     完全オフライン・バックグラウンドで連続再生する。
   - iOS対策の要点:
     * 単一の<audio>要素を使い回す(自動再生制約は初回タップで解除)
     * endedハンドラでは同期処理だけで次トラックのsrc差し替え+play()を行う
       (awaitを挟むとバックグラウンドで再生権を失うことがある)
     * blob URLは事前に作成してキャッシュしておく
   ========================================================= */

/* ---------- IndexedDB ---------- */
const DB_NAME = "kikinagashiPlayerDB";
const DB_VERSION = 1;
const STORE = "tracks";
let db;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      if (event.oldVersion < 1) {
        const store = req.result.createObjectStore(STORE, { keyPath: "id" });
        store.createIndex("subject", "subject");
      }
    };
    req.onblocked = () => alert("別のタブでこのアプリが開かれています。他のタブを閉じて再読み込みしてください。");
    req.onsuccess = () => {
      req.result.onversionchange = () => {
        req.result.close();
        alert("アプリが別のタブで更新されました。このタブは再読み込みしてください。");
      };
      resolve(req.result);
    };
    req.onerror = () => reject(req.error);
  });
}

function dbGetAll() {
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, "readonly").objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function dbPutAll(records) {
  return new Promise((resolve, reject) => {
    if (records.length === 0) { resolve(); return; }
    const t = db.transaction(STORE, "readwrite");
    const store = t.objectStore(STORE);
    for (const r of records) store.put(r);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

// 指定科目のレコードを全削除する(パック再取り込み時の丸ごと入れ替えに使う)。
function dbDeleteSubject(subject) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, "readwrite");
    const idx = t.objectStore(STORE).index("subject");
    const req = idx.openCursor(IDBKeyRange.only(subject));
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

/* ---------- utils ---------- */
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function shuffleArray(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* ---------- State ---------- */
const SPEEDS = [0.75, 1.0, 1.25, 1.5];
let allTracks = [];   // IndexedDBの全トラック(blob含む。blob実体はディスク側にあり必要時に読まれる)
let queue = [];       // 現在の再生キュー(トラックの配列)
let currentIdx = -1;
let speed = 1.0;
let shuffleOn = false;
let repeatMode = "all"; // "all"(全体リピート・既定) | "one"(1曲リピート) | "off"
const urlCache = new Map(); // trackId -> blob URL(セッション中は保持。endedハンドラを同期に保つため)
const audio = document.getElementById("audio");

function urlFor(track) {
  let url = urlCache.get(track.id);
  if (!url) {
    url = URL.createObjectURL(track.blob);
    urlCache.set(track.id, url);
  }
  return url;
}

/* ---------- Init ---------- */
(async function init() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
  db = await openDB();
  allTracks = await dbGetAll();

  speed = Number(localStorage.getItem("kkp_speed")) || 1.0;
  if (!SPEEDS.includes(speed)) speed = 1.0;
  shuffleOn = localStorage.getItem("kkp_shuffle") === "1";
  repeatMode = localStorage.getItem("kkp_repeatMode") || "all";
  if (!["all", "one", "off"].includes(repeatMode)) repeatMode = "all";

  wireNav();
  wireLibrary();
  wirePlayer();
  wireMediaSession();
  renderAll();
  restoreLastPlayback();
})();

function renderAll() {
  renderLibrary();
  renderSubjectSelect();
  renderPlayerAvailability();
  renderOptionButtons();
  renderStorageInfo();
}

/* ---------- Nav ---------- */
function wireNav() {
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => switchView(btn.dataset.view));
  });
}

function switchView(view) {
  document.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  document.querySelectorAll(".view").forEach((v) => v.classList.add("hidden"));
  document.getElementById("view-" + view).classList.remove("hidden");
}

/* ---------- ライブラリ(パック取り込み) ---------- */
function wireLibrary() {
  document.getElementById("pack-input").addEventListener("change", async (ev) => {
    const files = [...ev.target.files];
    ev.target.value = "";
    if (files.length === 0) return;
    const statusEl = document.getElementById("import-status");
    try {
      for (const file of files) {
        statusEl.textContent = `取り込み中: ${file.name} …`;
        await importPack(file);
      }
      allTracks = await dbGetAll();
      // 取り込んだblob URLを作り直すため、キャッシュを破棄する
      for (const url of urlCache.values()) URL.revokeObjectURL(url);
      urlCache.clear();
      stopPlayback();
      renderAll();
      rebuildQueue();
      statusEl.textContent = `${files.length}ファイルを取り込みました。`;
      // iOSのストレージ自動削除対策(ホーム画面追加済みなら通常は保持される)
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    } catch (err) {
      statusEl.textContent = "取り込みに失敗しました: " + err.message;
    }
  });

  document.getElementById("update-check-btn").addEventListener("click", checkForUpdate);
}

// .kkpackを解析してIndexedDBへ保存する。同じ科目の既存データは丸ごと入れ替え。
// 形式: "KKPACK"(6B) + ヘッダ長uint32LE(4B) + ヘッダJSON(UTF-8) + 音声バイナリ連結
async function importPack(file) {
  const head = new Uint8Array(await file.slice(0, 10).arrayBuffer());
  const magic = String.fromCharCode(...head.slice(0, 6));
  if (magic !== "KKPACK") throw new Error(`${file.name} はパックファイルではありません`);
  const headerLen = new DataView(head.buffer).getUint32(6, true);
  const header = JSON.parse(await file.slice(10, 10 + headerLen).text());
  const dataStart = 10 + headerLen;
  const subject = header.subject || "科目未設定";
  const tracks = header.tracks || [];
  if (tracks.length === 0) throw new Error(`${file.name} にトラックがありません`);
  const records = [];
  for (const t of tracks) {
    // File.slice(遅延参照)のままIndexedDBへ入れると、iOS Safariが保存後に切り出し範囲を
    // 失い全トラックが先頭(1番目)の音声を指すことがある。実バイトに読み出してから保存する。
    const bytes = await file.slice(dataStart + t.offset, dataStart + t.offset + t.length).arrayBuffer();
    records.push({
      id: t.id,
      subject,
      order: t.order || 0,
      title: t.title || "無題",
      body: t.body || "",
      generatedAt: header.generatedAt || "",
      blob: new Blob([bytes], { type: t.mime || "audio/mpeg" }),
    });
  }
  await dbDeleteSubject(subject);
  await dbPutAll(records);
}

function subjectSummary() {
  const map = new Map();
  for (const t of allTracks) {
    if (!map.has(t.subject)) map.set(t.subject, { count: 0, generatedAt: t.generatedAt || "" });
    map.get(t.subject).count++;
  }
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

function renderLibrary() {
  const ul = document.getElementById("library-list");
  ul.innerHTML = "";
  const summary = subjectSummary();
  if (summary.length === 0) {
    ul.innerHTML = '<li class="hint">まだ取り込んだ音声がありません。</li>';
    return;
  }
  for (const [subject, info] of summary) {
    const li = document.createElement("li");
    const date = info.generatedAt ? info.generatedAt.slice(0, 10) : "";
    li.innerHTML = `
      <div class="lib-info">
        <div class="lib-subject">${escapeHtml(subject)}</div>
        <div class="lib-meta">${info.count}トラック${date ? " / 生成: " + escapeHtml(date) : ""}</div>
      </div>
      <button class="lib-play-btn">▶ 再生</button>
      <button class="lib-delete-btn">削除</button>
    `;
    li.querySelector(".lib-play-btn").addEventListener("click", () => {
      document.getElementById("queue-subject").value = subject;
      localStorage.setItem("kkp_subject", subject);
      rebuildQueue();
      switchView("player");
      if (queue.length > 0) playTrackAt(0);
    });
    li.querySelector(".lib-delete-btn").addEventListener("click", async () => {
      if (!confirm(`「${subject}」(${info.count}トラック)を端末から削除しますか?\nパックを取り込み直せば復元できます。`)) return;
      await dbDeleteSubject(subject);
      allTracks = await dbGetAll();
      stopPlayback();
      renderAll();
      rebuildQueue();
    });
    ul.appendChild(li);
  }
}

async function renderStorageInfo() {
  const el = document.getElementById("storage-info");
  if (!navigator.storage || !navigator.storage.estimate) { el.textContent = ""; return; }
  try {
    const est = await navigator.storage.estimate();
    const usedMB = (est.usage / 1024 / 1024).toFixed(1);
    el.textContent = `端末内の使用量: 約${usedMB}MB`;
  } catch {
    el.textContent = "";
  }
}

/* ---------- アプリ更新 ---------- */
async function checkForUpdate() {
  const statusEl = document.getElementById("update-status");
  if (!("serviceWorker" in navigator)) { statusEl.textContent = "この環境では更新確認できません。"; return; }
  statusEl.textContent = "確認中…";
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) { statusEl.textContent = "確認できませんでした。"; return; }
    let reloaded = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (!reloaded) { reloaded = true; location.reload(); }
    });
    await reg.update();
    if (reg.installing || reg.waiting) {
      statusEl.textContent = "新しいバージョンを適用しています…";
    } else {
      statusEl.textContent = "最新の状態です。";
    }
  } catch {
    statusEl.textContent = "確認できませんでした(オフラインの可能性)。";
  }
}

/* ---------- プレイヤー ---------- */
function wirePlayer() {
  const subjectSel = document.getElementById("queue-subject");
  subjectSel.addEventListener("change", () => {
    localStorage.setItem("kkp_subject", subjectSel.value);
    stopPlayback();
    rebuildQueue();
  });

  document.getElementById("play-btn").addEventListener("click", togglePlay);
  document.getElementById("next-btn").addEventListener("click", () => stepTrack(1));
  document.getElementById("prev-btn").addEventListener("click", () => stepTrack(-1));
  document.getElementById("back5-btn").addEventListener("click", () => seekBy(-5));
  document.getElementById("fwd5-btn").addEventListener("click", () => seekBy(5));

  document.getElementById("shuffle-btn").addEventListener("click", () => {
    shuffleOn = !shuffleOn;
    localStorage.setItem("kkp_shuffle", shuffleOn ? "1" : "0");
    rebuildQueue(true);
    renderOptionButtons();
  });
  // リピートは 全体 → 1曲 → オフ の3段階切替(1つの論証を集中して覚えたいときは「1曲」)
  document.getElementById("repeat-btn").addEventListener("click", () => {
    repeatMode = repeatMode === "all" ? "one" : repeatMode === "one" ? "off" : "all";
    localStorage.setItem("kkp_repeatMode", repeatMode);
    renderOptionButtons();
  });
  // 速度は4ボタンから直接選択(巡回式だと目的の速度に行くまで別速度を経由して聞き逃すため)
  document.querySelectorAll(".speed-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      speed = Number(btn.dataset.speed);
      localStorage.setItem("kkp_speed", String(speed));
      audio.playbackRate = speed;
      renderOptionButtons();
    });
  });

  const seekbar = document.getElementById("seekbar");
  seekbar.addEventListener("input", () => {
    if (isFinite(audio.duration)) audio.currentTime = (seekbar.value / 100) * audio.duration;
  });

  // 再生位置の保存(5秒スロットル)と表示更新
  let lastSaved = 0;
  audio.addEventListener("timeupdate", () => {
    updateSeekUI();
    const now = Date.now();
    if (now - lastSaved > 5000 && currentIdx >= 0) {
      lastSaved = now;
      localStorage.setItem("kkp_lastPos", String(audio.currentTime));
    }
    updatePositionState();
  });
  audio.addEventListener("loadedmetadata", () => {
    audio.playbackRate = speed; // src差し替えでリセットされるブラウザがあるため再設定
    updateSeekUI();
  });
  audio.addEventListener("play", () => renderPlayButton(true));
  audio.addEventListener("pause", () => renderPlayButton(false));
  // 音声の読み込み失敗を無音で放置しない(データ破損時に気づけるようにする)
  audio.addEventListener("error", () => {
    if (currentIdx < 0) return;
    renderPlayButton(false);
    document.getElementById("now-body").textContent =
      "この音声を再生できませんでした。ライブラリで科目を削除し、パックを取り込み直してください。";
  });

  // ★ 連続再生の核心。バックグラウンドでも次トラックへ進めるよう、ここは同期処理のみにする。
  audio.addEventListener("ended", () => {
    if (repeatMode === "one" && currentIdx >= 0) {
      audio.currentTime = 0;
      const p = audio.play();
      if (p) p.catch(() => renderPlayButton(false));
    } else if (currentIdx + 1 < queue.length) {
      playTrackAt(currentIdx + 1);
    } else if (repeatMode === "all" && queue.length > 0) {
      playTrackAt(0);
    } else {
      renderPlayButton(false);
    }
  });
}

function renderSubjectSelect() {
  const sel = document.getElementById("queue-subject");
  const subjects = subjectSummary().map(([s]) => s);
  const saved = localStorage.getItem("kkp_subject") || "";
  sel.innerHTML = '<option value="">すべての科目</option>' +
    subjects.map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join("");
  sel.value = subjects.includes(saved) ? saved : "";
}

function renderPlayerAvailability() {
  const empty = allTracks.length === 0;
  document.getElementById("player-empty").classList.toggle("hidden", !empty);
  document.getElementById("player-main").classList.toggle("hidden", empty);
}

function renderOptionButtons() {
  document.getElementById("shuffle-btn").classList.toggle("on", shuffleOn);
  const repeatBtn = document.getElementById("repeat-btn");
  repeatBtn.textContent = repeatMode === "one" ? "🔂 1曲リピート" : "🔁 リピート";
  repeatBtn.classList.toggle("on", repeatMode !== "off");
  document.querySelectorAll(".speed-btn").forEach((btn) => {
    btn.classList.toggle("on", Number(btn.dataset.speed) === speed);
  });
}

function renderPlayButton(playing) {
  document.getElementById("play-btn").textContent = playing ? "⏸" : "▶";
  if ("mediaSession" in navigator) {
    navigator.mediaSession.playbackState = playing ? "playing" : "paused";
  }
}

// キューを組み直す。keepCurrent=trueなら再生中のトラックを先頭/現位置に保って続行する。
function rebuildQueue(keepCurrent) {
  const subject = document.getElementById("queue-subject").value;
  const current = currentIdx >= 0 ? queue[currentIdx] : null;
  let list = allTracks.filter((t) => !subject || t.subject === subject);
  list.sort((a, b) => a.subject.localeCompare(b.subject) || (a.order || 0) - (b.order || 0) || a.title.localeCompare(b.title));
  if (shuffleOn) {
    list = shuffleArray(list);
    if (keepCurrent && current) {
      const i = list.findIndex((t) => t.id === current.id);
      if (i > 0) { list.splice(i, 1); list.unshift(current); }
    }
  }
  queue = list;
  if (keepCurrent && current) {
    currentIdx = queue.findIndex((t) => t.id === current.id);
  } else if (!keepCurrent) {
    currentIdx = -1;
  }
  renderQueueList();
}

function renderQueueList() {
  const ol = document.getElementById("queue-list");
  ol.innerHTML = "";
  queue.forEach((t, i) => {
    const li = document.createElement("li");
    li.className = i === currentIdx ? "current" : "";
    li.innerHTML = `<span class="q-num">${i + 1}</span><span>${escapeHtml(t.title)}</span>`;
    li.addEventListener("click", () => playTrackAt(i));
    ol.appendChild(li);
  });
}

// idx番目のトラックを即座に再生する。endedハンドラからも呼ばれるため、この関数は同期で完結させる
// (blob URLの生成は同期API。IndexedDBアクセスや動的importを挟んではいけない)。
function playTrackAt(idx) {
  if (idx < 0 || idx >= queue.length) return;
  const prev = currentIdx;
  currentIdx = idx;
  const t = queue[idx];
  audio.src = urlFor(t);
  audio.playbackRate = speed;
  const p = audio.play();
  if (p) p.catch(() => renderPlayButton(false)); // 自動再生がブロックされた場合はボタン表示だけ戻す
  // 次のトラックのblob URLを先に作っておく(ended時の処理を確実に同期で済ませるため)
  const next = queue[idx + 1] || (repeatMode === "all" ? queue[0] : null);
  if (next) urlFor(next);
  localStorage.setItem("kkp_lastTrackId", t.id);
  localStorage.setItem("kkp_lastPos", "0");
  updateNowPlaying(t);
  if (prev !== idx) renderQueueList();
}

function updateNowPlaying(t) {
  document.getElementById("now-subject").textContent = t.subject;
  document.getElementById("now-title").textContent = t.title;
  document.getElementById("now-body").textContent = t.body || "";
  if ("mediaSession" in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t.title,
      artist: t.subject,
      album: "Listening",
      artwork: [
        { src: "icon-192.png", sizes: "192x192", type: "image/png" },
        { src: "icon-512.png", sizes: "512x512", type: "image/png" },
      ],
    });
  }
}

function togglePlay() {
  if (currentIdx < 0) {
    if (queue.length === 0) rebuildQueue();
    if (queue.length > 0) playTrackAt(0);
    return;
  }
  if (audio.paused) {
    audio.play().catch(() => {});
  } else {
    audio.pause();
    if (currentIdx >= 0) localStorage.setItem("kkp_lastPos", String(audio.currentTime));
  }
}

function stepTrack(dir) {
  if (queue.length === 0) return;
  if (currentIdx < 0) { playTrackAt(0); return; }
  // 先頭で「前へ」を押したら曲頭に戻す(音楽プレイヤーの一般的な挙動に合わせて3秒以上再生時も曲頭へ)
  if (dir === -1 && audio.currentTime > 3) {
    audio.currentTime = 0;
    return;
  }
  const wrap = repeatMode !== "off";
  let next = currentIdx + dir;
  if (next < 0) next = wrap ? queue.length - 1 : 0;
  if (next >= queue.length) next = wrap ? 0 : queue.length - 1;
  playTrackAt(next);
}

// 現在のトラック内で相対シークする(トラックはまたがない。末尾は少し手前で止めてendedの誤発火を避ける)。
function seekBy(delta) {
  if (currentIdx < 0 || !isFinite(audio.duration)) return;
  audio.currentTime = Math.min(Math.max(audio.currentTime + delta, 0), Math.max(audio.duration - 0.3, 0));
  updateSeekUI();
  updatePositionState();
}

function stopPlayback() {
  audio.pause();
  audio.removeAttribute("src");
  currentIdx = -1;
  document.getElementById("now-subject").textContent = "";
  document.getElementById("now-title").textContent = "";
  document.getElementById("now-body").textContent = "";
  renderPlayButton(false);
}

function updateSeekUI() {
  const seekbar = document.getElementById("seekbar");
  if (isFinite(audio.duration) && audio.duration > 0) {
    seekbar.value = (audio.currentTime / audio.duration) * 100;
    document.getElementById("time-total").textContent = fmtTime(audio.duration);
  }
  document.getElementById("time-current").textContent = fmtTime(audio.currentTime);
}

/* ---------- Media Session(ロック画面・イヤホン操作) ---------- */
function wireMediaSession() {
  if (!("mediaSession" in navigator)) return;
  navigator.mediaSession.setActionHandler("play", () => audio.play().catch(() => {}));
  navigator.mediaSession.setActionHandler("pause", () => audio.pause());
  navigator.mediaSession.setActionHandler("previoustrack", () => stepTrack(-1));
  navigator.mediaSession.setActionHandler("nexttrack", () => stepTrack(1));
  try {
    navigator.mediaSession.setActionHandler("seekto", (d) => {
      if (d.seekTime != null && isFinite(audio.duration)) audio.currentTime = d.seekTime;
    });
  } catch { /* seekto非対応の環境は無視 */ }
}

function updatePositionState() {
  if (!("mediaSession" in navigator) || !navigator.mediaSession.setPositionState) return;
  if (!isFinite(audio.duration) || audio.duration <= 0) return;
  try {
    navigator.mediaSession.setPositionState({
      duration: audio.duration,
      playbackRate: audio.playbackRate,
      position: Math.min(audio.currentTime, audio.duration),
    });
  } catch { /* 一部環境の一時的な不整合は無視 */ }
}

/* ---------- 前回の続きから ---------- */
// 前回再生していたトラックを画面に用意する(自動再生はしない。iOSの制約上、初回はタップが必要)。
function restoreLastPlayback() {
  rebuildQueue();
  const lastId = localStorage.getItem("kkp_lastTrackId");
  if (!lastId || queue.length === 0) return;
  const idx = queue.findIndex((t) => t.id === lastId);
  if (idx < 0) return;
  currentIdx = idx;
  const t = queue[idx];
  audio.src = urlFor(t);
  const pos = Number(localStorage.getItem("kkp_lastPos")) || 0;
  audio.addEventListener("loadedmetadata", function once() {
    audio.removeEventListener("loadedmetadata", once);
    if (pos > 0 && pos < audio.duration - 1) audio.currentTime = pos;
  });
  updateNowPlaying(t);
  renderQueueList();
}
