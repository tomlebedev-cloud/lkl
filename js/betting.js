// =====================================================================
//  Betting page (#bets): Monte Carlo simulation of the next round,
//  compared with bookmaker odds you type in (e.g. TopSport).
//  Loaded after app.js and uses its helpers (esc, teamById, predict, ...).
//  Odds, odds history, settings and your bet log are saved in this browser only
//  (Export / Import moves them to another browser).
// =====================================================================

// Spread of real results around the model's prediction, measured by backtest.py
// (written into MODEL by update_data.py; these defaults are only a fallback).
const SIM = Object.assign({ sdMargin: 12.8, marginBias: 1.2, sdTotal: 16.6, totalBias: 2.0, corr: 0 }, MODEL.sim || {});
const SIMS = 40000;

// ---------- storage (may be unavailable: private mode, blocked site data) ----------
// Every key starts with "lkl.": the other hubs on the same web address keep their own odds and bets.
const STORE = "lkl.";
function load(key, fallback) {
  try { return JSON.parse(localStorage.getItem(STORE + key)) ?? fallback; } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(STORE + key, JSON.stringify(value)); } catch { /* not saved, page still works */ }
}

const betSettings = Object.assign(
  { bankroll: 100, kelly: 0.25, maxPct: 2, minEdge: 5, modelWeight: 50 },
  load("bets.settings", {}));
const odds = load("bets.odds", {});   // odds you typed: game code -> { ml: [h, a], hcp: [line, h, a], tot: [line, o, u] }
// odds published with the site (js/odds.js) are used for games you haven't typed odds for
const published = typeof BOOK_ODDS !== "undefined" ? BOOK_ODDS : { games: {} };
const gameOdds = code => odds[code] || published.games[code] || {};
let myBets = load("bets.log", []);    // [{ id, code, market, side, line, odds, stake, placed }]
const lineups = load("bets.out", {});  // game code -> { player code: true (out) / false (plays) }
// every set of odds you typed, with the model's chances at that moment (the model changes after each round):
// game code -> [{ t: time, out: key players out, sels: [{ market, side, line, odds, fair, model, push }] }]
let oddsLog = load("bets.oddsLog", {});

// ---------- line-ups ----------
// AVAILABILITY (from update_data.py): team -> regulars [[code, PIR per game, missed latest game, left club]],
// best first. The top ABS.keyPlayers are key players: each one who doesn't play costs ABS.perPlayer points
// of margin (measured on 2023-24 to 2025-26, see backtest.py --absences).
const ABS = Object.assign({ keyPlayers: 3, perPlayer: 1.5 }, MODEL.absence || {});
const playerName = {};
TEAMS.forEach(t => t.players.forEach(p => { playerName[p.code] = p.name; }));
const regulars = id => (typeof AVAILABILITY !== "undefined" && AVAILABILITY[id]) || [];

function isOut(g, p) {
  if (p[3]) return true; // left the club
  // Only your own ticks count. "Missed the latest game" (p[2]) is shown as a hint but not applied:
  // on past seasons assuming those players stay out made predictions worse (backtest.py --absences).
  return lineups[g.code]?.[p[0]] ?? false;
}
const keyOut = (g, team) => regulars(team).slice(0, ABS.keyPlayers).filter(p => isOut(g, p));

// model prediction adjusted for who plays
function gamePrediction(g) {
  const p = predict(g.home, g.away, g.neutral);
  const outHome = keyOut(g, g.home), outAway = keyOut(g, g.away);
  const shift = ABS.perPlayer * (outAway.length - outHome.length); // home margin change; total unchanged
  // fast teams make for more points: possessions above the league average (model.PACE, backtest.py --pace)
  const paceOf = id => (MODEL.pace && MODEL.pace[id]) || 0;
  const margin = p.margin + shift, total = p.total + (MODEL.paceBeta || 0) * (paceOf(g.home) + paceOf(g.away));
  let hp = Math.round((total + margin) / 2), ap = Math.round((total - margin) / 2);
  if (hp === ap) margin >= 0 ? hp++ : ap++;
  return { homePts: hp, awayPts: ap, margin, total, shift, outHome, outAway };
}

// ---------- simulation ----------
function rng(seed) {  // mulberry32: same game -> same numbers on every page load
  return () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function normal(rand) {
  const u = 1 - rand(), v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const simCache = {};
// -> { margins: Int16Array, totals: Int16Array } of final scores (overtime included)
function simulate(g) {
  const p = gamePrediction(g);
  const key = `${g.code}|${p.margin.toFixed(3)}|${p.total.toFixed(3)}`;
  if (simCache[key]) return simCache[key];
  const mu = p.margin + SIM.marginBias, tot = p.total + SIM.totalBias;
  // same random numbers for a game, so line-up changes compare cleanly
  const rand = rng(Number(g.code) * 7919 + 17);
  const margins = new Int16Array(SIMS), totals = new Int16Array(SIMS);
  const c = SIM.corr, c2 = Math.sqrt(1 - c * c);
  const ot = Math.sqrt(5 / 40); // an overtime is 5 of 40 minutes
  for (let i = 0; i < SIMS; i++) {
    const z1 = normal(rand), z2 = normal(rand);
    const m = mu + SIM.sdMargin * z1;
    const t = tot + SIM.sdTotal * (c * z1 + c2 * z2);
    let hs = Math.round((t + m) / 2), as = Math.round((t - m) / 2);
    while (hs === as) { // tied after regulation: play overtime
      const om = mu / 8 + SIM.sdMargin * ot * normal(rand);
      const otot = tot / 8 + SIM.sdTotal * ot * normal(rand) / 2;
      hs += Math.round((otot + om) / 2);
      as += Math.round((otot - om) / 2);
    }
    margins[i] = hs - as;
    totals[i] = hs + as;
  }
  return simCache[key] = { margins, totals, pred: p };
}

// probability that a bet wins / is refunded (whole-number lines can push)
function chances(sim, market, side, line) {
  let win = 0, push = 0;
  const { margins, totals } = sim;
  for (let i = 0; i < SIMS; i++) {
    let x;
    if (market === "ml") x = side === "home" ? margins[i] : -margins[i];
    else if (market === "hcp") x = side === "home" ? margins[i] + line : -margins[i] - line;
    else x = side === "over" ? totals[i] - line : line - totals[i];
    if (x > 0) win++; else if (x === 0) push++;
  }
  return { win: win / SIMS, push: push / SIMS };
}

// median (= fair line) of a sorted copy
function median(arr) {
  const s = Float64Array.from(arr).sort();
  return s[s.length >> 1];
}

// ---------- evaluating odds ----------
// every selection that has odds typed in for game g
function selections(g) {
  const o = gameOdds(g.code), h = teamById[g.home], a = teamById[g.away];
  const out = [];
  const pair = (market, line, sides) => {
    const [s1, s2] = sides;
    if (!(s1.odds > 1 && s2.odds > 1)) { // only one side typed: no fair-price comparison
      sides.forEach(s => s.odds > 1 && out.push({ market, line, ...s, fair: null }));
      return;
    }
    const i1 = 1 / s1.odds, i2 = 1 / s2.odds; // remove the bookmaker margin proportionally
    out.push({ market, line, ...s1, fair: i1 / (i1 + i2), vig: i1 + i2 - 1 });
    out.push({ market, line, ...s2, fair: i2 / (i1 + i2), vig: i1 + i2 - 1 });
  };
  if (o.ml) pair("ml", 0, [{ side: "home", odds: o.ml[0] }, { side: "away", odds: o.ml[1] }]);
  if (o.hcp && isFinite(o.hcp[0])) pair("hcp", o.hcp[0], [{ side: "home", odds: o.hcp[1] }, { side: "away", odds: o.hcp[2] }]);
  if (o.tot && o.tot[0] > 0) pair("tot", o.tot[0], [{ side: "over", odds: o.tot[1] }, { side: "under", odds: o.tot[2] }]);

  const sim = simulate(g);
  return out.map(s => {
    const c = chances(sim, s.market, s.side, s.line);
    return price({ ...s, label: betLabel(g, s), game: g, model: c.win, push: c.push });
  });
}

// adds pWin (chance used), ev and stake to a selection with odds, fair (bookmaker) and model chances
function price(s) {
  const w = betSettings.modelWeight / 100;
  // the bookmaker follows the news more closely than the model: blend toward its price
  const winNoPush = s.model / (1 - s.push || 1);
  const blended = s.fair == null ? winNoPush : w * winNoPush + (1 - w) * s.fair;
  const pWin = blended * (1 - s.push);
  const ev = pWin * s.odds + s.push - 1;
  return { ...s, pWin, ev, stake: stake(pWin, s.push, s.odds) };
}

// fractional Kelly, capped; 0 when there's no edge
function stake(pWin, pPush, o) {
  const pLose = 1 - pWin - pPush, b = o - 1;
  const f = (b * pWin - pLose) / b;
  if (f <= 0) return 0;
  const pct = Math.min(f * betSettings.kelly, betSettings.maxPct / 100);
  return Math.floor(pct * betSettings.bankroll * 2) / 2; // round down to 0.50
}

const pct = p => (100 * p).toFixed(1) + "%";
const evText = ev => `<span class="${ev > 0 ? "plus" : "minus"}">${ev > 0 ? "+" : ""}${(100 * ev).toFixed(1)}%</span>`;
const isValue = s => s.ev * 100 >= betSettings.minEdge && s.stake > 0;

// ---------- my bets ----------
// 1 = won, 0 = refunded (push), -1 = lost, null = not played yet
function outcome(b) {
  const g = gameByCode[b.code];
  if (!g || !g.score) return null;
  const m = g.score[0] - g.score[1], t = g.score[0] + g.score[1];
  let x;
  if (b.market === "ml") x = b.side === "home" ? m : -m;
  else if (b.market === "hcp") x = b.side === "home" ? m + b.line : -m - b.line;
  else x = b.side === "over" ? t - b.line : b.line - t;
  return Math.sign(x);
}
function settle(b) {
  const r = outcome(b);
  return r === null ? null : r > 0 ? b.stake * (b.odds - 1) : r === 0 ? 0 : -b.stake;
}

// ---------- odds template ----------
// A plain-text form for all games of the round: fill in the bookmaker's odds and paste it back
// (on this page, or into a chat). Lines: "#code Home – Away", "Win: home away",
// "Hcp: home-line home away", "Tot: line over under". Missing numbers are simply skipped.
function oddsTemplate(games) {
  const v = x => x ?? "";
  return L(`LKL week ${games[0]?.round ?? ""} odds. Decimal odds; handicap line for the HOME team (e.g. -4.5).`,
    `LKL ${games[0]?.round ?? ""} savaitės koeficientai. Win = pergalė (namai, svečiai); Hcp = fora NAMŲ komandai (pvz. -4.5),
namai, svečiai; Tot = totalas, daugiau, mažiau.`) + "\n\n"
    + games.map(g => {
      const o = gameOdds(g.code), h = teamById[g.home], a = teamById[g.away];
      return `#${g.code} ${h.name} – ${a.name} (${fmtDate(g.date)} ${fmtTime(g.date)})
Win: ${v(o.ml?.[0])} ${v(o.ml?.[1])}
Hcp: ${v(o.hcp?.[0])} ${v(o.hcp?.[1])} ${v(o.hcp?.[2])}
Tot: ${v(o.tot?.[0])} ${v(o.tot?.[1])} ${v(o.tot?.[2])}`;
    }).join("\n\n");
}

// -> number of games updated
function applyTemplate(text) {
  let code = null, n = 0;
  const changed = new Set();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const head = line.match(/^#(\d+)/);
    if (head) { code = gameByCode[head[1]] && !started(gameByCode[head[1]]) ? head[1] : null; continue; }
    const m = line.match(/^(win|hcp|tot)\s*:\s*(.*)$/i);
    if (!code || !m) continue;
    const nums = (m[2].match(/[-+]?\d+(?:[.,]\d+)?/g) || []).map(x => Number(x.replace(",", ".")));
    const key = { win: "ml", hcp: "hcp", tot: "tot" }[m[1].toLowerCase()];
    const size = key === "ml" ? 2 : 3;
    if (nums.length < size) continue;
    odds[code] = odds[code] || JSON.parse(JSON.stringify(published.games[code] || {}));
    odds[code][key] = nums.slice(0, size);
    changed.add(code);
  }
  save("bets.odds", odds);
  changed.forEach(c => { recordOdds(gameByCode[c]); n++; });
  return n;
}

// ---------- odds history ----------
const tipOff = g => Date.parse(g.utc ? (/[Z+]/.test(g.utc.slice(10)) ? g.utc : g.utc + "Z") : g.date);
const started = g => Date.now() >= tipOff(g);

// save the odds typed for game g, with the model's chances now; edits within 30 minutes replace the last save
function recordOdds(g) {
  const sels = selections(g).filter(s => s.fair != null); // complete pairs only
  const list = oddsLog[g.code] = oddsLog[g.code] || [];
  const last = list[list.length - 1];
  const recent = last && Date.now() - Date.parse(last.t) < 30 * 60 * 1000;
  if (!sels.length) { // all odds cleared
    if (recent) list.pop();
    if (!list.length) delete oddsLog[g.code];
  } else {
    const p = gamePrediction(g);
    const entry = {
      t: new Date().toISOString(),
      out: [...p.outHome, ...p.outAway].map(x => x[0]),
      sels: sels.map(x => ({ market: x.market, side: x.side, line: x.line, odds: x.odds,
        fair: +x.fair.toFixed(4), model: +x.model.toFixed(4), push: +x.push.toFixed(4) })),
    };
    if (recent) list[list.length - 1] = entry; else list.push(entry);
  }
  save("bets.oddsLog", oddsLog);
}

// published odds count in the history too (once per game, before tip-off)
function recordPublished() {
  for (const code of Object.keys(published.games)) {
    const g = gameByCode[code];
    if (g && !g.score && !started(g) && !oddsLog[code]) recordOdds(g);
  }
}

// the last odds saved before tip-off, for each finished game
function closingOdds() {
  return Object.entries(oddsLog).map(([code, list]) => {
    const g = gameByCode[code];
    if (!g || !g.score) return null;
    const before = list.filter(e => Date.parse(e.t) < tipOff(g));
    return before.length ? { g, e: before[before.length - 1] } : null;
  }).filter(Boolean).sort((a, b) => tipOff(a.g) - tipOff(b.g));
}

function historyCard() {
  const games = closingOdds();
  const pending = Object.keys(oddsLog).filter(c => !gameByCode[c]?.score).length;
  if (!games.length) {
    return `<div class="card"><h2>${L("Model vs bookmaker", "Modelis prieš lažybų bendrovę")}</h2>
      <p class="muted">${L(`Odds you type in are saved automatically with the model's chances at that moment.
        Once games are played, this shows whether the model or the bookmaker priced them better.`,
        `Įvesti koeficientai automatiškai išsaugomi kartu su tuometinėmis modelio tikimybėmis. Po rungtynių čia
        matysite, kas tiksliau įvertino: modelis ar lažybų bendrovė.`)}
        ${pending ? L(`Saved so far: ${pending} game${pending > 1 ? "s" : ""} waiting for results.`,
          `Išsaugota: ${pending} rungt. laukia rezultatų.`) : ""}</p></div>`;
  }
  // accuracy: log loss of both on the side that the odds were on (home / over), pushes left out
  const acc = { ml: [0, 0, 0], hcp: [0, 0, 0], tot: [0, 0, 0] }; // [games, model loss, bookmaker loss]
  const flat = { n: 0, won: 0, profit: 0 }; // 1 unit on every value bet
  const rows = [];
  for (const { g, e } of games) {
    for (const s of e.sels) {
      const r = outcome({ code: g.code, ...s });
      if (s.side === "home" || s.side === "over") {
        if (r !== 0) {
          const hit = r > 0, a = acc[s.market];
          const pm = Math.min(Math.max(s.model / (1 - s.push || 1), 1e-4), 1 - 1e-4);
          a[0]++;
          a[1] -= Math.log(hit ? pm : 1 - pm);
          a[2] -= Math.log(hit ? s.fair : 1 - s.fair);
        }
      }
      const priced = price(s);
      if (isValue(priced)) {
        flat.n++;
        flat.won += r > 0;
        flat.profit += r > 0 ? s.odds - 1 : r < 0 ? -1 : 0;
        rows.push({ g, s, priced, r });
      }
    }
  }
  const names = { ml: L("Winner", "Nugalėtojas"), hcp: L("Handicap", "Fora"), tot: L("Total", "Totalas") };
  const accRows = Object.entries(acc).filter(([, a]) => a[0]).map(([k, a]) => {
    const m = a[1] / a[0], b = a[2] / a[0];
    return `<tr><td class="left">${names[k]}</td><td>${a[0]}</td><td>${m.toFixed(3)}</td><td>${b.toFixed(3)}</td>
      <td class="${m < b ? "plus" : "minus"}">${m < b ? L("model", "modelis") : L("bookmaker", "lažybų bendrovė")}</td></tr>`;
  }).join("");
  const fmtOut = r => r > 0 ? `<span class="plus">${L("won", "laimėta")}</span>` : r < 0 ? `<span class="minus">${L("lost", "pralaimėta")}</span>` : L("push", "grąžinta");
  return `<div class="card">
    <h2>${L("Model vs bookmaker", "Modelis prieš lažybų bendrovę")}</h2>
    <p class="note" style="margin-top:0">${L(`${games.length} finished game${games.length > 1 ? "s" : ""} with odds saved before
      tip-off${pending ? ` · ${pending} waiting for results` : ""}. Lower log loss = better chances.`,
      `Pasibaigusių rungtynių su koeficientais, išsaugotais iki pradžios: ${games.length}${pending ? ` · laukia rezultatų: ${pending}` : ""}.
      Mažesnis „log loss“ = tikslesnės tikimybės.`)}</p>
    <div class="table-wrap"><table>
      <thead><tr><th class="left">${L("Market", "Rinka")}</th><th>${L("Games", "Rungt.")}</th><th>${L("Model", "Modelis")}</th><th>${L("Bookmaker", "Lažybų bendr.")}</th><th>${L("Better", "Tikslesnis")}</th></tr></thead>
      <tbody>${accRows || `<tr><td colspan='5' class='muted left'>${L("No complete odds yet.", "Pilnų koeficientų dar nėra.")}</td></tr>`}</tbody>
    </table></div>
    <p class="record">${L("Every value bet at 1 € (current settings)", "Kiekvienas vertės statymas po 1 € (dabartiniai nustatymai)")}: <b>${flat.n}</b> ${L("bets", "statymų")}, ${flat.won} ${L("won", "laimėta")}, ${L("profit", "pelnas")}
      <b class="${flat.profit >= 0 ? "plus" : "minus"}">${flat.profit >= 0 ? "+" : ""}${flat.profit.toFixed(2)} €</b>
      ${flat.n ? `(${(100 * flat.profit / flat.n).toFixed(1)}% ROI)` : ""}</p>
    ${rows.length ? `<details class="lines"><summary>${L("Value bets in detail", "Vertės statymai išsamiai")}</summary><div class="table-wrap"><table>
      <thead><tr><th class="left">${L("Game", "Rungtynės")}</th><th class="left">${L("Bet", "Statymas")}</th><th>${L("Odds", "Koef.")}</th><th>${L("Model", "Modelis")}</th><th>${L("Value", "Vertė")}</th><th>${L("Final", "Rezultatas")}</th><th>${L("Result", "Baigtis")}</th></tr></thead>
      <tbody>${rows.map(({ g, s, priced, r }) => `<tr>
        <td class="left"><a href="#game/${g.code}">R${g.round} ${esc(teamById[g.home].short)}–${esc(teamById[g.away].short)}</a></td>
        <td class="left">${esc(betLabel(g, s))}</td><td>${s.odds.toFixed(2)}</td><td>${pct(s.model)}</td>
        <td>${evText(priced.ev)}</td><td>${g.score.join("–")}</td><td>${fmtOut(r)}</td></tr>`).join("")}</tbody>
    </table></div></details>` : ""}
    <p class="note">${L(`Judge this after 100+ bets: over a few weeks it is mostly luck. A model that beats the
      bookmaker's log loss over a season is rare; profit without that is probably luck too.`,
      `Vertinkite po 100+ statymų: per kelias savaites tai daugiausia sėkmė. Modelis, per sezoną lenkiantis lažybų
      bendrovės „log loss“, yra retenybė; pelnas be to greičiausiai irgi sėkmė.`)}</p>
  </div>`;
}

function betLabel(g, s) {
  const h = teamById[g.home], a = teamById[g.away];
  if (s.market === "ml") return L(`${(s.side === "home" ? h : a).name} to win`, `${(s.side === "home" ? h : a).name} laimės`);
  if (s.market === "hcp") return s.side === "home" ? `${h.name} ${signed(s.line)}` : `${a.name} ${signed(-s.line)}`;
  return `${s.side === "over" ? L("Over", "Daugiau nei") : L("Under", "Mažiau nei")} ${s.line}`;
}

// move everything saved to another browser
function exportData() {
  const data = { version: 1, exported: new Date().toISOString(), oddsLog, myBets, lineups, odds, settings: betSettings };
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 1)], { type: "application/json" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: `lkl-bets-${new Date().toISOString().slice(0, 10)}.json` });
  a.click();
  URL.revokeObjectURL(url);
}
function importData(file) {
  file.text().then(text => {
    const d = JSON.parse(text);
    // merge: imported odds history is added to what is here, newer entries win per game
    for (const [code, list] of Object.entries(d.oddsLog || {})) {
      const mine = oddsLog[code] || [];
      const byTime = new Map([...mine, ...list].map(e => [e.t, e]));
      oddsLog[code] = [...byTime.values()].sort((x, y) => Date.parse(x.t) - Date.parse(y.t));
    }
    const ids = new Set(myBets.map(b => b.id));
    myBets = myBets.concat((d.myBets || []).filter(b => !ids.has(b.id)));
    Object.assign(lineups, d.lineups || {});
    Object.assign(odds, d.odds || {});
    save("bets.oddsLog", oddsLog); save("bets.log", myBets); save("bets.out", lineups); save("bets.odds", odds);
    route();
  }).catch(() => alert(L("That file could not be read.", "Nepavyko perskaityti failo.")));
}

function myBetsCard() {
  if (!myBets.length) return "";
  let staked = 0, profit = 0, open = 0;
  const rows = myBets.map(b => {
    const r = settle(b), g = gameByCode[b.code];
    if (r === null) open += b.stake; else { staked += b.stake; profit += r; }
    const status = r === null ? `<span class='muted'>${L("open", "laukia")}</span>`
      : r > 0 ? `<span class="plus">${L("won", "laimėta")} +${r.toFixed(2)}</span>`
      : r < 0 ? `<span class="minus">${L("lost", "pralaimėta")} ${r.toFixed(2)}</span>` : L("push", "grąžinta");
    return `<tr>
      <td class="left">${g ? `<a href="#game/${g.code}">R${g.round} ${esc(teamById[g.home].short)}–${esc(teamById[g.away].short)}</a>` : esc(b.code)}</td>
      <td class="left">${esc(g ? betLabel(g, b) : b.label)}</td><td>${b.odds.toFixed(2)}</td><td>${b.stake.toFixed(2)}</td>
      <td>${g && g.score ? g.score.join("–") : ""}</td><td>${status}</td>
      <td><button class="link" data-del="${b.id}" title="${L("Remove", "Pašalinti")}">✕</button></td></tr>`;
  }).join("");
  return `<div class="card">
    <h2>${L("My bets", "Mano statymai")}</h2>
    <p class="record">${L("Settled: staked", "Įvertinti: pastatyta")} <b>${staked.toFixed(2)}</b> · ${L("profit", "pelnas")}
      <b class="${profit >= 0 ? "plus" : "minus"}">${profit >= 0 ? "+" : ""}${profit.toFixed(2)}</b>
      ${staked ? `(${(100 * profit / staked).toFixed(1)}% ROI)` : ""} · ${L("open", "laukia")}: ${open.toFixed(2)}</p>
    <div class="table-wrap"><table>
      <thead><tr><th class="left">${L("Game", "Rungtynės")}</th><th class="left">${L("Bet", "Statymas")}</th><th>${L("Odds", "Koef.")}</th><th>${L("Stake", "Suma")}</th><th>${L("Final", "Rezultatas")}</th><th>${L("Result", "Baigtis")}</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <p class="note">${L("Saved in this browser only. Results fill in automatically after the data update.",
      "Saugoma tik šioje naršyklėje. Rezultatai atsiranda automatiškai, kai atsinaujina duomenys.")}</p>
  </div>`;
}

// ---------- page ----------
function oddsInput(code, key, i, placeholder, step = "0.01") {
  const v = gameOdds(code)[key]?.[i];
  return `<input type="number" inputmode="decimal" step="${step}" data-code="${code}" data-key="${key}" data-i="${i}"
    placeholder="${placeholder}" value="${v ?? ""}" ${started(gameByCode[code]) ? "disabled" : ""}>`;
}

function fairOdds(p) { return p > 0 ? (1 / p).toFixed(2) : "–"; }

function lineupList(g, team) {
  const regs = regulars(team);
  if (!regs.length) return `<p class="muted">${L("Not enough games yet.", "Dar per mažai rungtynių.")}</p>`;
  return regs.map((p, i) => `<label class="lineup ${p[3] ? "muted" : ""} ${i < ABS.keyPlayers ? "key" : ""}">
      <input type="checkbox" data-player="${p[0]}" ${isOut(g, p) ? "checked" : ""} ${p[3] ? "disabled" : ""}>
      <span>${i < ABS.keyPlayers ? "★ " : ""}${esc(playerName[p[0]] || p[0])}</span>
      <small>${p[3] ? L("left club · ", "išėjo iš klubo · ") : p[2] ? L("missed last game · ", "praleido paskutines · ") : ""}${p[1].toFixed(1)} PIR</small>
    </label>`).join("");
}

function modelBox(g) {
  const sim = simulate(g), p = sim.pred, h = teamById[g.home], a = teamById[g.away];
  const pHome = chances(sim, "ml", "home", 0).win;
  const fairHcp = -median(sim.margins), fairTot = median(sim.totals);
  // model probabilities at lines around the fair ones, for quick comparison with the bookmaker
  const hcpLines = [-6, -3, 0, 3, 6].map(d => Math.round(fairHcp) + d + 0.5);
  const totLines = [-8, -4, 0, 4, 8].map(d => Math.round(fairTot) + d + 0.5);
  const names = list => list.map(x => esc(playerName[x[0]] || x[0]) + (x[3] ? L(" (left club)", " (išėjo iš klubo)") : "")).join(", ");
  const outs = [[h, p.outHome], [a, p.outAway]].filter(([, l]) => l.length)
    .map(([t, l]) => `${esc(t.short)} ${L("without", "be")} ${names(l)}`).join("; ");
  const shift = Math.abs(p.shift) >= 0.05
    ? L(` · line-ups move the margin <b>${signed(+p.shift.toFixed(1))}</b> for ${esc(h.short)}`,
        ` · sudėtys keičia ${esc(h.short)} skirtumą <b>${signed(+p.shift.toFixed(1))}</b>`) : "";
  return `
    <p class="model-line">${L("Model", "Modelis")}: <b>${p.homePts}–${p.awayPts}</b> · ${esc(h.short)} ${L("wins", "laimi")} ${pct(pHome)}
      (${L("fair odds", "teisingi koef.")} ${fairOdds(pHome)} / ${fairOdds(1 - pHome)}) · ${L("fair handicap", "teisinga fora")} <b>${esc(h.short)} ${signed(fairHcp)}</b>
      · ${L("fair total", "teisingas totalas")} <b>${fairTot}</b>${shift}</p>
    ${outs ? `<p class="note out-line">${L("Key players out", "Nežais pagrindiniai žaidėjai")}: ${outs}</p>` : ""}
    <details class="lines" data-details="lineup"><summary>${L("Line-ups: tick players who won't play", "Sudėtys: pažymėkite nežaisiančius žaidėjus")}</summary>
      <div class="grid-2">
        <div><div class="round-title">${esc(h.name)}</div>${lineupList(g, g.home)}</div>
        <div><div class="round-title">${esc(a.name)}</div>${lineupList(g, g.away)}</div>
      </div>
      <p class="note">${L(`Regulars by PIR per game. ★ = key player: each one who misses the game costs his team
        about ${ABS.perPlayer} points (measured on the last three seasons); other players don't move the prediction.
        Players who left the club are counted out. "Missed last game" is only a hint, because players often
        return: check the injury news and tick those who really won't play.`,
        `Nuolatiniai žaidėjai pagal PIR per rungtynes. ★ = pagrindinis žaidėjas: kiekvienas nežaidžiantis atima iš komandos
        maždaug ${ABS.perPlayer} taško (išmatuota per tris praėjusius sezonus); kiti žaidėjai prognozės nekeičia.
        Išėję iš klubo laikomi nežaidžiančiais. „Praleido paskutines“ yra tik užuomina, nes žaidėjai dažnai
        grįžta: patikrinkite traumų naujienas ir pažymėkite tuos, kurie tikrai nežais.`)}
        <button class="link" data-reset="${g.code}">${L("Reset", "Atstatyti")}</button></p>
    </details>
    <details class="lines" data-details="chances"><summary>${L("Model chances at other lines", "Modelio tikimybės prie kitų linijų")}</summary>
      <div class="grid-2">
        <table><thead><tr><th class="left">${esc(h.short)} ${L("handicap", "fora")}</th><th>${L(`${esc(h.short)} covers`, `${esc(h.short)} įveikia`)}</th><th>${L("Fair odds", "Teisingi koef.")}</th></tr></thead><tbody>
          ${hcpLines.map(l => { const c = chances(sim, "hcp", "home", l).win;
            return `<tr><td class="left">${signed(l)}</td><td>${pct(c)}</td><td>${fairOdds(c)}</td></tr>`; }).join("")}
        </tbody></table>
        <table><thead><tr><th class="left">${L("Total", "Totalas")}</th><th>${L("Over", "Daugiau")}</th><th>${L("Fair odds", "Teisingi koef.")}</th></tr></thead><tbody>
          ${totLines.map(l => { const c = chances(sim, "tot", "over", l).win;
            return `<tr><td class="left">${l}</td><td>${pct(c)}</td><td>${fairOdds(c)} / ${fairOdds(1 - c)}</td></tr>`; }).join("")}
        </tbody></table>
      </div>
    </details>`;
}

function gameCard(g) {
  const h = teamById[g.home], a = teamById[g.away];
  return `<div class="card bet-game" data-code="${g.code}">
    ${gameRow(g, true)}
    <div class="model-box">${modelBox(g)}</div>
    ${started(g) ? `<p class="note">${L("Started: odds are locked, the history keeps those saved before tip-off.",
      "Prasidėjo: koeficientai užrakinti, istorijoje lieka išsaugoti iki pradžios.")}</p>` : ""}
    <div class="odds-grid">
      <span class="lbl">${L("Winner", "Nugalėtojas")}</span>
      <label>${esc(h.short)} ${oddsInput(g.code, "ml", 0, L("odds", "koef."))}</label>
      <label>${esc(a.short)} ${oddsInput(g.code, "ml", 1, L("odds", "koef."))}</label>
      <span></span>
      <span class="lbl">${L("Handicap", "Fora")}</span>
      <label>${esc(h.short)} ${L("line", "linija")} ${oddsInput(g.code, "hcp", 0, "-4.5", "0.5")}</label>
      <label>${esc(h.short)} ${oddsInput(g.code, "hcp", 1, L("odds", "koef."))}</label>
      <label>${esc(a.short)} ${oddsInput(g.code, "hcp", 2, L("odds", "koef."))}</label>
      <span class="lbl">${L("Total", "Totalas")}</span>
      <label>${L("line", "linija")} ${oddsInput(g.code, "tot", 0, "160.5", "0.5")}</label>
      <label>${L("over", "daugiau")} ${oddsInput(g.code, "tot", 1, L("odds", "koef."))}</label>
      <label>${L("under", "mažiau")} ${oddsInput(g.code, "tot", 2, L("odds", "koef."))}</label>
    </div>
    <div class="sel-table"></div>
  </div>`;
}

function selTable(sels) {
  if (!sels.length) return "";
  return `<div class="table-wrap"><table>
    <thead><tr><th class="left">${L("Bet", "Statymas")}</th><th>${L("Odds", "Koef.")}</th><th>${L("Bookmaker", "Lažybų bendr.")}</th><th>${L("Model", "Modelis")}</th><th>${L("Used", "Naudojama")}</th><th>${L("Value", "Vertė")}</th><th>${L("Stake", "Suma")}</th><th></th></tr></thead>
    <tbody>${sels.map(s => `<tr class="${isValue(s) ? "value" : ""}">
      <td class="left">${esc(s.label)}</td><td>${s.odds.toFixed(2)}</td>
      <td>${s.fair == null ? "–" : pct(s.fair)}</td><td>${pct(s.model)}</td><td>${pct(s.pWin)}</td>
      <td>${evText(s.ev)}</td><td>${s.stake ? s.stake.toFixed(2) : "–"}</td>
      <td>${s.stake ? `<button class="link" data-add='${esc(JSON.stringify({ code: s.game.code, market: s.market, side: s.side, line: s.line, odds: s.odds, stake: s.stake, label: s.label }))}'>${L("+ my bets", "+ į mano statymus")}</button>` : ""}</td>
    </tr>`).join("")}</tbody>
  </table></div>`;
}

// the next round, or the one after it (#bets/5, #ticket/5)
function chosenRound(params) {
  const nr = nextRound(), want = Number(params && params[0]);
  return want && upcoming.some(g => g.round === want) ? want : nr;
}
function roundTabs(page, current) {
  const nr = nextRound();
  if (!nr) return "";
  const rounds = [nr, nr + 1].filter(r => upcoming.some(g => g.round === r));
  return `<div class="controls">${rounds.map(r => `<a class="tab ${r === current ? "active" : ""}" href="#${page}/${r}">${L(`Week ${r}`, `${r} savaitė`)}</a>`).join("")}
    ${current !== nr ? `<span class="note">${L(`Week ${current} uses today's ratings; they change after week ${nr} is played.`,
      `${current} savaitei naudojami šiandienos reitingai; jie pasikeis po ${nr} savaitės.`)}</span>` : ""}</div>`;
}

pages.bets = params => {
  const nr = chosenRound(params);
  if (!nr) return `<div id="betsPage"><h1>${L("Betting", "Statymai")}</h1><div class="card"><p class="muted">${L("No upcoming games.", "Artimiausių rungtynių nėra.")}</p></div>
    <div id="myBets">${myBetsCard()}</div><div id="history">${historyCard()}</div></div>`;
  const games = upcoming.filter(g => g.round === nr);
  const s = betSettings;
  return `<div id="betsPage"><h1>${L(`Betting — Week ${nr}`, `Statymai — ${nr} savaitė`)}</h1>${roundTabs("bets", nr)}
    <div class="card">
      ${published.source ? `<p class="note" style="margin-top:0">${L(`Odds already filled in: ${esc(published.source)}, ${esc(published.taken)}
        (winner only). Change them if the price has moved.`, `Koeficientai jau įrašyti: ${esc(published.source)}, ${esc(published.taken)}
        (tik nugalėtojas). Pakeiskite, jei kaina pasikeitė.`)}</p>` : ""}
      <p style="margin-top:0">${L(`Each game is simulated ${SIMS.toLocaleString("en")} times from the model's prediction, with
        the spread of real results around its predictions measured on 562 past games
        (final score, overtime included). Type in the bookmaker's
        decimal odds; bets where the model sees value are highlighted with a suggested stake.`,
        `Kiekvienos rungtynės simuliuojamos ${SIMS.toLocaleString("lt")} kartų pagal modelio prognozę, su tikrų rezultatų
        sklaida, išmatuota 562 praėjusiose rungtynėse (galutinis rezultatas, su pratęsimais). Įveskite lažybų bendrovės
        dešimtainius koeficientus; statymai, kuriuose modelis mato vertę, paryškinami su siūloma suma.`)}</p>
      <div class="controls settings">
        <label>${L("Bankroll", "Bankas")} <input type="number" id="sBankroll" min="0" step="10" value="${s.bankroll}"></label>
        <label>${L("Model weight", "Modelio svoris")} <input type="number" id="sWeight" min="0" max="100" step="10" value="${s.modelWeight}">%</label>
        <label>${L("Min value", "Min. vertė")} <input type="number" id="sEdge" min="0" step="1" value="${s.minEdge}">%</label>
        <label>Kelly <input type="number" id="sKelly" min="0" max="1" step="0.05" value="${s.kelly}"></label>
        <label>${L("Max stake", "Maks. suma")} <input type="number" id="sMax" min="0" step="0.5" value="${s.maxPct}">${L("% of bankroll", "% banko")}</label>
      </div>
      <p class="note">${L(`
        <b>Bookmaker</b> = the bookmaker's chance with its margin removed. <b>Model</b> = simulation.
        <b>Used</b> = blend of both by "model weight": the bookmaker follows the news more closely than the model.
        <b>Value</b> = expected return per 1 € staked. <b>Stake</b> = ${s.kelly} Kelly, at most ${s.maxPct}% of bankroll.`, `
        <b>Lažybų bendr.</b> = lažybų bendrovės tikimybė be maržos. <b>Modelis</b> = simuliacija.
        <b>Naudojama</b> = abiejų mišinys pagal „modelio svorį“: lažybų bendrovė naujienas seka atidžiau nei modelis.
        <b>Vertė</b> = tikėtina grąža nuo 1 € statymo. <b>Suma</b> = ${s.kelly} Kelly, ne daugiau ${s.maxPct}% banko.`)}
      </p>
    </div>
    <div class="card">
      <h2>${L("Odds template", "Koeficientų šablonas")}</h2>
      <p class="note" style="margin-top:0">${L(`Faster than typing: copy the template, fill in TopSport's odds (in a notes app or
        right here), then paste it back below and press Apply. The same text can be pasted into a chat with Claude.`,
        `Greičiau nei vesti po vieną: nukopijuokite šabloną, įrašykite TopSport koeficientus (užrašuose arba čia pat),
        įklijuokite atgal ir spauskite „Taikyti“. Tą patį tekstą galima įklijuoti ir į pokalbį su Claude.`)}</p>
      <div class="controls"><button id="copyTemplate">${L("Copy template", "Kopijuoti šabloną")}</button><button class="primary" id="applyTemplate">${L("Apply", "Taikyti")}</button>
        <span id="templateMsg" class="note"></span></div>
      <textarea id="templateBox" rows="8" spellcheck="false">${esc(oddsTemplate(games))}</textarea>
    </div>
    <div class="card" id="bestBets"></div>
    ${games.map(gameCard).join("")}
    <div id="myBets">${myBetsCard()}</div>
    <div id="history">${historyCard()}</div>
    <div class="card">
      <h2>${L("Your data", "Jūsų duomenys")}</h2>
      <p class="note" style="margin-top:0">${L(`Odds history, bets and line-ups are saved in this browser only.
        Export a file to keep a backup or to move them to your phone; importing adds to what is here.`,
        `Koeficientų istorija, statymai ir sudėtys saugomi tik šioje naršyklėje. Eksportuokite failą atsarginei kopijai
        arba perkėlimui į telefoną; importuojant duomenys pridedami prie esamų.`)}</p>
      <div class="controls" style="margin-bottom:0">
        <button id="exportBtn">${L("Export", "Eksportuoti")}</button>
        <label class="button-like">${L("Import", "Importuoti")} <input type="file" id="importFile" accept="application/json,.json" hidden></label>
      </div>
    </div>
    <div class="card note">
      <h2>${L("Read this before betting", "Perskaitykite prieš statydami")}</h2>
      ${L(`<p>The model picks about 70% of winners, but bookmakers' prices are usually at least as good, and their
        margin (typically 5–8%) has to be beaten first. "Value" here means the model disagrees with the bookmaker;
        it is not a guarantee. The model does not know who is injured: tick injured key players
        yourself from the news before betting. On past seasons, knowing the line-ups did not make the model's
        win chances better: bookmakers react to injury news fast, so the edge is in being quicker.
        Over a few weeks results are mostly luck; keep the log below to see whether it works over 100+ bets.</p>
      <p>Totals (over/under) are the weakest part: on past seasons the model missed the total by 12.9 points on
        average. Winner and handicap bets rest on firmer ground.</p>
      <p>Bet only money you can afford to lose. Help in Lithuania: Lošimų priežiūros tarnyba, tel. 8 800 222 99 (free).</p>`,
      `<p>Modelis atspėja maždaug 70 % nugalėtojų, bet lažybų bendrovių kainos dažniausiai bent tokios pat geros, o jų
        maržą (paprastai 5–8 %) pirmiausia reikia įveikti. „Vertė“ čia reiškia, kad modelis nesutinka su lažybų bendrove;
        tai ne garantija. Modelis nežino, kas traumuotas: traumuotus pagrindinius žaidėjus
        pažymėkite patys pagal naujienas. Praėjusiuose sezonuose žinomos sudėtys modelio tikimybių nepagerino:
        lažybų bendrovės į traumų naujienas reaguoja greitai, todėl pranašumas yra greitume.
        Per kelias savaites rezultatus daugiausia lemia sėkmė; veskite žurnalą ir vertinkite po 100+ statymų.</p>
      <p>Totalai (daugiau/mažiau) yra silpniausia vieta: praėjusiuose sezonuose modelis taškų sumą prašaudavo vidutiniškai
        12,9 taško. Nugalėtojo ir foros statymai remiasi tvirtesniu pagrindu.</p>
      <p>Statykite tik tiek, kiek galite sau leisti prarasti. Pagalba: Lošimų priežiūros tarnyba, tel. 8 800 222 99 (nemokamai).</p>`)}
    </div></div>`;
};

setup.bets = params => {
  recordPublished();
  const nr = chosenRound(params);
  const games = nr ? upcoming.filter(g => g.round === nr) : [];

  const renderGame = card => {
    const g = gameByCode[card.dataset.code];
    card.querySelector(".sel-table").innerHTML = selTable(selections(g));
  };
  const renderBest = () => {
    const box = document.getElementById("bestBets");
    if (!box) return;
    const all = games.flatMap(selections);
    const best = all.filter(isValue).sort((a, b) => b.ev - a.ev);
    const total = best.reduce((t, s) => t + s.stake, 0);
    box.innerHTML = `<h2>${L("Best value this week", "Geriausia šios savaitės vertė")}</h2>` + (!all.length
      ? `<p class='muted'>${L("Type in bookmaker odds below to compare them with the model.", "Įveskite koeficientus žemiau, kad palygintumėte juos su modeliu.")}</p>`
      : best.length
        ? selTable(best) + `<p class="note">${L(`${best.length} bet${best.length > 1 ? "s" : ""}, total stake ${total.toFixed(2)}.`,
            `Statymų: ${best.length}, bendra suma ${total.toFixed(2)}.`)}</p>`
        : `<p class="muted">${L(`No bet reaches ${betSettings.minEdge}% value at the odds entered.`,
            `Prie įvestų koeficientų nė vienas statymas nepasiekia ${betSettings.minEdge}% vertės.`)}</p>`);
  };
  const renderAll = () => {
    document.querySelectorAll(".bet-game").forEach(renderGame);
    renderBest();
  };

  document.querySelectorAll(".odds-grid input").forEach(inp => inp.addEventListener("input", () => {
    const { code, key, i } = inp.dataset;
    const size = key === "ml" ? 2 : 3;
    odds[code] = odds[code] || JSON.parse(JSON.stringify(published.games[code] || {})); // start from the published ones
    odds[code][key] = odds[code][key] || Array(size).fill(null);
    odds[code][key][i] = inp.value === "" ? null : Number(inp.value);
    save("bets.odds", odds);
    renderGame(inp.closest(".bet-game"));
    renderBest();
    scheduleRecord(gameByCode[code]);
  }));

  const timers = {};
  const scheduleRecord = g => {
    clearTimeout(timers[g.code]);
    timers[g.code] = setTimeout(() => { recordOdds(g); document.getElementById("history").innerHTML = historyCard(); }, 1500);
  };

  // line-up changes: redraw that game's model part, keeping open sections open
  const redrawModel = card => {
    const box = card.querySelector(".model-box");
    const open = [...box.querySelectorAll("details[open]")].map(d => d.dataset.details);
    box.innerHTML = modelBox(gameByCode[card.dataset.code]);
    open.forEach(k => box.querySelector(`details[data-details="${k}"]`)?.setAttribute("open", ""));
    renderGame(card);
    renderBest();
  };
  const page = document.getElementById("betsPage");
  page && page.addEventListener("change", e => {
    const cb = e.target.closest("input[data-player]");
    if (!cb) return;
    const card = cb.closest(".bet-game"), code = card.dataset.code;
    lineups[code] = lineups[code] || {};
    lineups[code][cb.dataset.player] = cb.checked;
    save("bets.out", lineups);
    redrawModel(card);
    if (oddsLog[code] && !started(gameByCode[code])) scheduleRecord(gameByCode[code]);
  });

  document.getElementById("exportBtn")?.addEventListener("click", exportData);

  const box = document.getElementById("templateBox"), msg = document.getElementById("templateMsg");
  document.getElementById("copyTemplate")?.addEventListener("click", () => {
    box.value = oddsTemplate(games);
    box.select();
    (navigator.clipboard ? navigator.clipboard.writeText(box.value) : Promise.reject())
      .then(() => { msg.textContent = L("Copied.", "Nukopijuota."); }, () => { document.execCommand("copy"); msg.textContent = L("Copied.", "Nukopijuota."); });
  });
  document.getElementById("applyTemplate")?.addEventListener("click", () => {
    const n = applyTemplate(box.value);
    route(); // redraw everything with the new odds
    const m = document.getElementById("templateMsg");
    if (m) m.textContent = n ? L(`Odds updated for ${n} game${n > 1 ? "s" : ""}.`, `Koeficientai atnaujinti: ${n} rungt.`)
      : L("No odds found: keep the #number lines.", "Koeficientų nerasta: palikite #numerio eilutes.");
  });
  document.getElementById("importFile")?.addEventListener("change", e => e.target.files[0] && importData(e.target.files[0]));

  const fields = { sBankroll: "bankroll", sWeight: "modelWeight", sEdge: "minEdge", sKelly: "kelly", sMax: "maxPct" };
  Object.entries(fields).forEach(([id, key]) => {
    const inp = document.getElementById(id);
    inp && inp.addEventListener("input", () => {
      if (inp.value === "" || !isFinite(inp.value)) return;
      betSettings[key] = Number(inp.value);
      save("bets.settings", betSettings);
      renderAll();
    });
  });

  // add / remove bets in the log, reset line-ups (buttons are re-rendered, so listen on the page)
  page && page.addEventListener("click", e => {
    const add = e.target.closest("[data-add]"), del = e.target.closest("[data-del]");
    const reset = e.target.closest("[data-reset]");
    if (reset) {
      delete lineups[reset.dataset.reset];
      save("bets.out", lineups);
      redrawModel(reset.closest(".bet-game"));
      if (oddsLog[reset.dataset.reset]) scheduleRecord(gameByCode[reset.dataset.reset]);
      return;
    }
    if (add) {
      myBets.push({ id: Date.now(), placed: new Date().toISOString(), ...JSON.parse(add.dataset.add) });
      add.textContent = L("✓ added", "✓ pridėta");
      add.disabled = true;
    } else if (del) {
      myBets = myBets.filter(b => String(b.id) !== del.dataset.del);
    } else return;
    save("bets.log", myBets);
    document.getElementById("myBets").innerHTML = myBetsCard();
  });

  renderAll();
};
