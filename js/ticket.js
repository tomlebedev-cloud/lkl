// =====================================================================
//  Ticket page (#ticket): what the model would put on a betting ticket
//  for the next round, and why. Uses the odds typed on the Betting page
//  when there are any; otherwise shows the minimum odds each pick needs.
//  Loaded after betting.js and uses its functions (simulate, selections, ...).
// =====================================================================

const MAX_LEGS = 3; // a combo longer than this multiplies the bookmaker's margin too much

setup.ticket = () => {
  recordPublished();
  const inp = document.getElementById("tBankroll");
  inp && inp.addEventListener("change", () => {
    if (inp.value === "" || !isFinite(inp.value)) return;
    betSettings.bankroll = Number(inp.value);
    save("bets.settings", betSettings);
    route();
  });
};

// ---------- reasons ----------
function netRatings() {
  const t = MODEL.teams;
  const net = Object.keys(t).map(id => ({ id, net: t[id][0] - t[id][1] })).sort((a, b) => b.net - a.net);
  const rank = {};
  net.forEach((x, i) => { rank[x.id] = { pos: i + 1, net: x.net }; });
  return rank;
}

const ordinal = n => L(n + (n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] || "th"), `${n}-a`);

// plain-language reasons for picking `side` ("home" / "away") in game g
function reasons(g, side) {
  const pick = side === "home" ? g.home : g.away, other = side === "home" ? g.away : g.home;
  const P = teamById[pick], O = teamById[other];
  const rank = netRatings(), table = computeStandings();
  const row = id => table.find(r => r.id === id);
  const p = gamePrediction(g);
  const out = [];

  const rp = rank[pick], ro = rank[other];
  const n = Object.keys(rank).length;
  out.push(L(`Rating: ${esc(P.name)} ${ordinal(rp.pos)} of ${n} (${signed(+rp.net.toFixed(1))} points per game
    vs an average team), ${esc(O.name)} ${ordinal(ro.pos)} (${signed(+ro.net.toFixed(1))}).`,
    `Reitingas: ${esc(P.name)} ${ordinal(rp.pos)} iš ${n} (${signed(+rp.net.toFixed(1))} taško per rungtynes, palyginti su
    vidutine komanda), ${esc(O.name)} ${ordinal(ro.pos)} (${signed(+ro.net.toFixed(1))}).`));
  if (!g.neutral) out.push(side === "home"
    ? L(`Home court: worth about ${MODEL.hca} points.`, `Namų aikštė: verta maždaug ${MODEL.hca} taškų.`)
    : L(`Plays away: the model already takes ${MODEL.hca} points off for that and still prefers ${esc(P.name)}.`,
        `Žaidžia svečiuose: modelis už tai jau atima ${MODEL.hca} taškus ir vis tiek labiau tiki ${esc(P.name)}.`));
  const rP = row(pick), rO = row(other);
  if (rP.gp) out.push(L(`This season: ${esc(P.short)} ${rP.w}–${rP.l} (${signed(rP.diff)}), form ${rP.form.join("") || "–"};
    ${esc(O.short)} ${rO.w}–${rO.l} (${signed(rO.diff)}), form ${rO.form.join("") || "–"}.`,
    `Šį sezoną: ${esc(P.short)} ${rP.w}–${rP.l} (${signed(rP.diff)}), forma ${rP.form.join("") || "–"};
    ${esc(O.short)} ${rO.w}–${rO.l} (${signed(rO.diff)}), forma ${rO.form.join("") || "–"}.`));
  if (rP.gp && rP.diff < rO.diff) out.push(`<span class="minus">${L(`Against: ${esc(O.short)} has the better start this season;
    the model trusts last season and the rosters more than ${rP.gp} games. Bet smaller or skip.`,
    `Prieš: ${esc(O.short)} šį sezoną pradėjo geriau; modelis labiau pasitiki praėjusiu sezonu ir sudėtimis nei ${rP.gp}
    rungtynėmis. Statykite mažiau arba praleiskite.`)}</span>`);
  const meetings = played.filter(x => (x.home === pick && x.away === other) || (x.home === other && x.away === pick));
  meetings.forEach(x => out.push(`${L("Earlier this season", "Anksčiau šį sezoną")}: ${esc(teamById[x.home].short)} ${x.score[0]}–${x.score[1]} ${esc(teamById[x.away].short)}.`));
  const outPick = side === "home" ? p.outHome : p.outAway, outOther = side === "home" ? p.outAway : p.outHome;
  const nm = l => l.map(x => esc(playerName[x[0]] || x[0])).join(", ");
  if (outOther.length) out.push(L(`${esc(O.short)} without key player${outOther.length > 1 ? "s" : ""} ${nm(outOther)}.`,
    `${esc(O.short)} be pagrindinių žaidėjų: ${nm(outOther)}.`));
  if (outPick.length) out.push(`<span class="minus">${L(`Risk: ${esc(P.short)} without ${nm(outPick)} (already in the numbers).`,
    `Rizika: ${esc(P.short)} be ${nm(outPick)} (jau įskaičiuota).`)}</span>`);
  const isNew = id => typeof NEW_TEAMS !== "undefined" && NEW_TEAMS.includes(id);
  if (isNew(pick)) out.push(`<span class="minus">${L(`${esc(P.name)} is new to the LKL: its rating started from a rough guess
    (the usual level of promoted teams) and rests on only ${rP.gp} games, so this pick is less certain than the numbers say.`,
    `${esc(P.name)} lygoje nauja: jos reitingas prasidėjo nuo apytikslio spėjimo (įprasto naujokių lygio) ir remiasi
    tik ${rP.gp} rungtynėmis, todėl šis pasirinkimas mažiau patikimas, nei rodo skaičiai.`)}</span>`);
  if (isNew(other)) out.push(`<span class="minus">${L(`${esc(O.name)} is new to the LKL: its rating is still a rough guess.`,
    `${esc(O.name)} lygoje nauja: jos reitingas kol kas apytikslis.`)}</span>`);
  if (played.length < 60) out.push(`<span class="muted">${L(`Early season: ratings still lean on last season and summer transfers,
    so surprises are more likely than later.`, `Sezono pradžia: reitingai dar remiasi praėjusiu sezonu ir vasaros perėjimais,
    todėl staigmenų tikimybė didesnė nei vėliau.`)}</span>`);
  return out;
}

// ---------- picks ----------
// each game's model favourite, with the minimum odds that make it worth betting
function modelPicks(games) {
  return games.map(g => {
    const sim = simulate(g);
    const pHome = chances(sim, "ml", "home", 0).win;
    const side = pHome >= 0.5 ? "home" : "away", p = side === "home" ? pHome : 1 - pHome;
    return { g, side, p, minOdds: (1 + betSettings.minEdge / 100) / p, pred: sim.pred };
  }).sort((a, b) => b.p - a.p);
}

const confidence = p => p >= 0.75 ? [L("strong", "tvirtas"), "plus"] : p >= 0.62 ? [L("lean", "nežymus"), ""] : [L("toss-up", "lygios"), "minus"];

// reasons for an over / under bet
function totalReasons(g, side, line) {
  const p = gamePrediction(g), table = computeStandings();
  const row = id => table.find(r => r.id === id);
  const out = [L(`Model total ${Math.round(p.total + SIM.totalBias)} vs the line ${line}
    (${side === "over" ? "more" : "fewer"} points expected).`, `Modelio totalas ${Math.round(p.total + SIM.totalBias)}, linija ${line}
    (tikimasi ${side === "over" ? "daugiau" : "mažiau"} taškų).`)];
  [g.home, g.away].forEach(id => {
    const r = row(id), t = teamById[id];
    if (r.gp) out.push(L(`${esc(t.short)} games average ${((r.pf + r.pa) / r.gp).toFixed(1)} points (${(r.pf / r.gp).toFixed(1)} scored,
      ${(r.pa / r.gp).toFixed(1)} allowed).`, `${esc(t.short)} rungtynėse vidutiniškai ${((r.pf + r.pa) / r.gp).toFixed(1)} taško
      (${(r.pf / r.gp).toFixed(1)} pelnyta, ${(r.pa / r.gp).toFixed(1)} praleista).`));
  });
  const pace = (MODEL.pace?.[g.home] || 0) + (MODEL.pace?.[g.away] || 0);
  if (MODEL.paceBeta && Math.abs(pace) >= 1) out.push(L(`Pace: these teams play ${Math.abs(pace).toFixed(1)} possessions ${pace > 0 ? "faster" : "slower"}
    than average, worth ${signed(+(MODEL.paceBeta * pace).toFixed(1))} points on the total.`,
    `Tempas: šios komandos žaidžia ${Math.abs(pace).toFixed(1)} atakos ${pace > 0 ? "greičiau" : "lėčiau"} nei vidutiniškai,
    tai keičia totalą ${signed(+(MODEL.paceBeta * pace).toFixed(1))} taško.`));
  out.push(`<span class="minus">${L("Totals are the model's weakest market (average miss 13 points): smaller stakes.",
    "Totalai yra silpniausia modelio rinka (vidutiniškai prašauna 13 taškų): mažesnės sumos.")}</span>`);
  return out;
}

// one bet with its reasons. s: { market, side, line } (+ label)
function legCard(g, s, extra) {
  const isTotal = s.market === "tot";
  const team = isTotal ? null : teamById[s.side === "home" ? g.home : g.away];
  const title = betLabel(g, s);
  const why = isTotal ? totalReasons(g, s.side, s.line) : reasons(g, s.side);
  return `<div class="leg">
    <div class="leg-head">${team ? badge(team, "sm") : ""}<b>${esc(title)}</b>
      <span class="muted">· ${esc(teamById[g.home].short)}–${esc(teamById[g.away].short)}, ${fmtDate(g.date)} ${fmtTime(g.date)}</span></div>
    ${extra}
    <ul class="why">${why.map(r => `<li>${r}</li>`).join("")}</ul>
  </div>`;
}

function comboSummary(legs, pAll, oddsAll) {
  const ev = oddsAll ? pAll * oddsAll - 1 : null;
  const st = oddsAll ? stake(pAll, 0, oddsAll) : 0;
  return `<p class="record">${L(`Combo of ${legs}: model chance all win`, `Kombinuotas (${legs}): tikimybė, kad laimės visi,`)} <b>${pct(pAll)}</b>
    ${oddsAll
      ? ` · ${L("combined odds", "bendras koef.")} <b>${oddsAll.toFixed(2)}</b> · ${L("value", "vertė")} ${evText(ev)} · ${L("stake", "suma")} ${st ? `<b>${st.toFixed(2)}</b>` : L("– (no value)", "– (nėra vertės)")}`
      : ` · ${L("worth it only at combined odds of at least", "apsimoka tik nuo bendro koef.")} <b>${((1 + betSettings.minEdge / 100) / pAll).toFixed(2)}</b>`}</p>`;
}

pages.ticket = params => {
  const nr = chosenRound(params);
  if (!nr) return `<h1>${L("Ticket", "Bilietas")}</h1><div class="card"><p class="muted">${L("No upcoming games.", "Artimiausių rungtynių nėra.")}</p></div>`;
  const games = upcoming.filter(g => g.round === nr && !started(g));
  if (!games.length) return `<h1>${L(`Ticket — Week ${nr}`, `Bilietas — ${nr} savaitė`)}</h1><div class="card"><p class="muted">${L("All games of this week have started.", "Visos šios savaitės rungtynės jau prasidėjo.")}</p></div>`;

  // with bookmaker odds: value bets; the combo takes the safest value legs from different games
  const sels = games.flatMap(selections);
  const value = sels.filter(isValue).sort((a, b) => b.ev - a.ev);
  const comboLegs = [];
  [...value].filter(s => s.pWin >= 0.55).sort((a, b) => b.pWin - a.pWin).forEach(s => {
    if (comboLegs.length < MAX_LEGS && !comboLegs.some(x => x.game === s.game)) comboLegs.push(s);
  });

  const picks = modelPicks(games);
  let ticket;
  if (sels.length) {
    const singles = value.length ? value.map(s => legCard(s.game, s,
      `<p>${L("Bet", "Statymas")}: <b>${esc(s.label)}</b> ${L("at", "už")} <b>${s.odds.toFixed(2)}</b> · ${L("bookmaker", "lažybų bendr.")} ${pct(s.fair)}
        ${L("vs model", "prieš modelį")} ${pct(s.model)} · ${L("value", "vertė")} ${evText(s.ev)} · ${L("stake", "suma")} <b>${s.stake.toFixed(2)}</b></p>`)).join("")
      : `<p class="muted">${L(`At the odds you entered nothing reaches ${betSettings.minEdge}% value. The honest ticket this week
          is no ticket, or wait for the odds to move.`, `Prie šių koeficientų niekas nepasiekia ${betSettings.minEdge}% vertės.
          Sąžiningas bilietas šiai savaitei: jokio bilieto arba palaukti, kol koeficientai pasikeis.`)}</p>`;
    const pAll = comboLegs.reduce((t, s) => t * s.pWin, 1), oAll = comboLegs.reduce((t, s) => t * s.odds, 1);
    ticket = `
      <div class="card">
        <h2>${L("1. Singles (recommended)", "1. Viengubi statymai (rekomenduojama)")}</h2>
        <p class="note" style="margin-top:0">${L("Each bet on its own: the bookmaker's margin is paid once per bet.",
          "Kiekvienas statymas atskiru bilietu: lažybų bendrovės marža mokama tik kartą.")}</p>
        ${singles}
      </div>
      <div class="card">
        <h2>${L("2. Combo ticket", "2. Kombinuotas bilietas")}</h2>
        ${comboLegs.length >= 2
          ? `<p class="note" style="margin-top:0">${L(`The ${comboLegs.length} most likely value bets from different games.`,
              `${comboLegs.length} labiausiai tikėtini vertės statymai iš skirtingų rungtynių.`)}</p>
             ${comboLegs.map(s => `<p>• <b>${esc(s.label)}</b> ${L("at", "už")} ${s.odds.toFixed(2)} (${L("chance used", "naudojama tikimybė")} ${pct(s.pWin)})</p>`).join("")}
             ${comboSummary(comboLegs.length + L(" bets", " statymai"), pAll, oAll)}`
          : `<p class="muted">${L(`Fewer than two value bets with a decent chance (55%+) in different games, so no combo.
               Adding legs without value only adds the bookmaker's margin.`, `Mažiau nei du vertės statymai su pakankama tikimybe (55 %+)
               skirtingose rungtynėse, todėl kombinuoto nėra. Pridėti statymai be vertės tik padidina lažybų bendrovės maržą.`)}</p>`}
      </div>`;
  } else {
    const top = picks.filter(x => x.p >= 0.62).slice(0, MAX_LEGS);
    const pAll = top.reduce((t, x) => t * x.p, 1);
    ticket = `
      <div class="card">
        <h2>${L("The model's ticket", "Modelio bilietas")}</h2>
        <p class="note" style="margin-top:0">${L(`No TopSport odds entered yet (type them on the <a href="#bets">Betting</a> page).
          Below are the model's ${top.length} most likely winners from different games. Each is worth betting only if
          TopSport offers at least the minimum odds shown; lower than that and the bookmaker has the edge.`,
          `TopSport koeficientų dar nėra (įveskite juos <a href="#bets">Statymų</a> puslapyje). Žemiau — ${top.length} labiausiai
          tikėtini nugalėtojai iš skirtingų rungtynių. Statyti verta tik tada, kai TopSport siūlo bent nurodytą mažiausią
          koeficientą; jei mažiau, pranašumas lažybų bendrovės pusėje.`)}</p>
        ${top.map(x => legCard(x.g, { market: "ml", side: x.side }, `<p>${L("Model chance", "Modelio tikimybė")} <b>${pct(x.p)}</b> · ${L("predicted", "prognozė")}
          ${x.pred.homePts}–${x.pred.awayPts} · ${L("fair odds", "teisingas koef.")} ${(1 / x.p).toFixed(2)} · <b>${L(`bet only at ${x.minOdds.toFixed(2)} or more`, `statyti tik nuo ${x.minOdds.toFixed(2)}`)}</b></p>`)).join("")}
        ${top.length >= 2 ? comboSummary(top.length + L(" picks", " pasirinkimai"), pAll, null) : ""}
      </div>`;
  }

  return `<h1>${L(`Ticket — Week ${nr}`, `Bilietas — ${nr} savaitė`)}</h1>${roundTabs("ticket", nr)}
    <div class="card">
      <p style="margin-top:0">${L("What the model would put on a ticket for this week and why.", "Ką modelis dėtų į šios savaitės bilietą ir kodėl.")}
        ${published.source ? L(`Odds: ${esc(published.source)}, ${esc(published.taken)}, unless you typed your own on the
        <a href="#bets">Betting</a> page.`, `Koeficientai: ${esc(published.source)}, ${esc(published.taken)}, nebent įvedėte savus
        <a href="#bets">Statymų</a> puslapyje.`) : ""}</p>
      <div class="controls settings" style="margin-bottom:0">
        <label>${L("Your bankroll", "Jūsų bankas")} <input type="number" id="tBankroll" min="0" step="5" value="${betSettings.bankroll}"> €</label>
        <span class="note">${L(`Stakes: ${betSettings.kelly} Kelly, at most ${betSettings.maxPct}% of the bankroll per bet
          (${(betSettings.bankroll * betSettings.maxPct / 100).toFixed(2)} €). The rest stays for the next weeks.`,
          `Sumos: ${betSettings.kelly} Kelly, ne daugiau ${betSettings.maxPct}% banko vienam statymui
          (${(betSettings.bankroll * betSettings.maxPct / 100).toFixed(2)} €). Likusi dalis lieka kitoms savaitėms.`)}</span>
      </div>
    </div>
    ${ticket}
    <div class="card">
      <h2>${L("All games at a glance", "Visos rungtynės trumpai")}</h2>
      <div class="table-wrap"><table>
        <thead><tr><th class="left">${L("Game", "Rungtynės")}</th><th class="left">${L("Model pick", "Modelio pasirinkimas")}</th><th>${L("Chance", "Tikimybė")}</th><th>${L("Fair odds", "Teisingas koef.")}</th><th>${L("Bet at ≥", "Statyti nuo ≥")}</th><th>${L("Confidence", "Užtikrintumas")}</th></tr></thead>
        <tbody>${picks.map(x => {
          const [label, cls] = confidence(x.p);
          return `<tr><td class="left"><a href="#game/${x.g.code}">${esc(teamById[x.g.home].short)}–${esc(teamById[x.g.away].short)}</a></td>
            <td class="left">${esc(teamById[x.side === "home" ? x.g.home : x.g.away].name)}</td><td>${pct(x.p)}</td>
            <td>${(1 / x.p).toFixed(2)}</td><td><b>${x.minOdds.toFixed(2)}</b></td><td class="${cls}">${label}</td></tr>`;
        }).join("")}</tbody>
      </table></div>
      <p class="note">${L("Toss-ups (under 62%) are poor ticket material unless the odds are clearly above the minimum.",
        "Lygios rungtynės (mažiau nei 62 %) netinka bilietui, nebent koeficientas aiškiai didesnis už mažiausią.")}</p>
    </div>
    <div class="card note">
      <h2>${L("Why singles beat long combos", "Kodėl viengubi statymai geresni už ilgus kombinuotus")}</h2>
      ${L(`<p>Every leg carries the bookmaker's margin (about 5%). Three legs at fair-ish odds lose about 15% on average;
        a combo only makes sense when every leg has value on its own. The chances above assume the games are
        independent, which they are when the legs come from different games.</p>
      <p>The model picked about 70% of winners over the last three seasons, and it doesn't know about injuries
        after each team's latest game: check the news and tick missing players on the Betting page.
        Bet only money you can afford to lose. Help: Lošimų priežiūros tarnyba, tel. 8 800 222 99.</p>`,
      `<p>Kiekviena bilieto dalis turi lažybų bendrovės maržą (apie 5 %). Trys dalys prie maždaug teisingų koeficientų
        vidutiniškai praranda apie 15 %; kombinuotas apsimoka tik tada, kai kiekviena dalis pati turi vertę. Tikimybės
        aukščiau laiko rungtynes nepriklausomomis, o taip ir yra, kai dalys iš skirtingų rungtynių.</p>
      <p>Per tris praėjusius sezonus modelis atspėjo apie 70 % nugalėtojų, ir jis nežino apie traumas po paskutinių
        komandos rungtynių: patikrinkite naujienas ir pažymėkite nežaisiančius žaidėjus Statymų puslapyje.
        Statykite tik tiek, kiek galite sau leisti prarasti. Pagalba: Lošimų priežiūros tarnyba, tel. 8 800 222 99.</p>`)}
    </div>`;
};
