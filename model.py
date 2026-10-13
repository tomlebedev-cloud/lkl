"""
Prediction model shared by update_data.py (website) and backtest.py (accuracy testing).

Each team gets an offensive rating (points scored above league average) and a
defensive rating (points allowed above league average), estimated from all
games played so far:

    home points = league average + home advantage / 2 + home offense + away defense
    away points = league average - home advantage / 2 + away offense + home defense

The ratings are found with a weighted ridge regression:
  - opponent-adjusted: beating strong teams counts more than beating weak ones
  - recent games weigh more than old ones (RECENCY_HALF_LIFE_DAYS)
  - ratings are pulled toward a prior: last season's final rating, shrunk by
    CARRYOVER (rosters change every summer); PRIOR_STRENGTH is worth
    "this many games" of evidence, so early-season predictions lean on last
    season and later ones on this season's games.

The predicted margin becomes a win probability with a logistic curve.
Parameters below were chosen with backtest.py on past seasons.
"""

import json
import math
import random
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path

import lkl

HOME_ADVANTAGE = 1.2          # points
PRIOR_STRENGTH = 18.0          # games' worth of weight on the prior
CARRYOVER = 0.85               # share of last season's rating kept
RECENCY_HALF_LIFE_DAYS = 240   # a game this many days old counts half
TALENT_WEIGHT = 1.0          # net points per 1000 PIR of roster change
NEW_TEAM_PRIOR = (-7.0, 2.5)  # (offense, defense) for promoted teams (python backtest.py --promoted)
LOGISTIC_SCALE = 5.5          # margin -> probability: p = 1 / (1 + exp(-margin / scale))
DEFAULT_AVERAGE = 86.0        # league points per team per game when nothing is known

# How far real results land from the prediction (python backtest.py --spread, 562 games 2023-24 to 2025-26).
# The betting page simulates games with these: final margin and total ~ normal(prediction + bias, sd).
SIM = {"sdMargin": 12.8, "marginBias": 1.2, "sdTotal": 16.6, "totalBias": 2.0, "corr": 0.0}

# Missing players (python backtest.py --absences). A team's key players are its 3 regulars (played at
# least half its games) with the highest PIR per game; early in the season that leans on last season's
# PIR (worth priorGames games). Each key player who doesn't play costs his team perPlayer points of margin.
ABSENCE = {"keyPlayers": 3, "perPlayer": 1.5, "minGames": 3, "minShare": 0.5, "priorGames": 5}


def parse_date(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00")).replace(tzinfo=None)


def simplify_games(raw_games):
    """lkl.py game dicts -> plain dicts the model works with (played games only).
    LKL games, playoffs included, are always played at one team's home, so none is neutral."""
    out = []
    for g in raw_games:
        if not g.get("played"):
            continue
        out.append({
            "code": g["code"],
            "date": parse_date(g["utc"]),
            "home": g["home"],
            "away": g["away"],
            "hs": g["score"][0],
            "as": g["score"][1],
            "neutral": False,
            "phase": g["phase"],
        })
    out.sort(key=lambda g: g["date"])
    return out


def _solve(a, b):
    """Solve a·x = b (Gaussian elimination with partial pivoting)."""
    n = len(b)
    m = [row[:] + [b[i]] for i, row in enumerate(a)]
    for c in range(n):
        p = max(range(c, n), key=lambda r: abs(m[r][c]))
        m[c], m[p] = m[p], m[c]
        piv = m[c][c]
        for r in range(c + 1, n):
            f = m[r][c] / piv
            if f:
                row_r, row_c = m[r], m[c]
                for k in range(c, n + 1):
                    row_r[k] -= f * row_c[k]
    x = [0.0] * n
    for r in range(n - 1, -1, -1):
        s = m[r][n] - sum(m[r][k] * x[k] for k in range(r + 1, n))
        x[r] = s / m[r][r]
    return x


class Ratings:
    def __init__(self, avg, off, dfn, hca=HOME_ADVANTAGE, scale=LOGISTIC_SCALE):
        self.avg, self.off, self.dfn, self.hca, self.scale = avg, off, dfn, hca, scale

    def predict(self, home, away, neutral=False):
        """-> (home points, away points, home win probability)"""
        h = 0 if neutral else self.hca / 2
        o, d = self.off, self.dfn
        hp = self.avg + h + o.get(home, NEW_TEAM_PRIOR[0]) + d.get(away, NEW_TEAM_PRIOR[1])
        ap = self.avg - h + o.get(away, NEW_TEAM_PRIOR[0]) + d.get(home, NEW_TEAM_PRIOR[1])
        return hp, ap, 1 / (1 + math.exp(-(hp - ap) / self.scale))

    def to_json(self, teams):
        # Shown ratings are centred on this season's teams, so "+2" means two points better than the average
        # team of the league. The average moves by the same amount, so predictions stay exactly the same.
        off = {t: self.off.get(t, NEW_TEAM_PRIOR[0]) for t in teams}
        dfn = {t: self.dfn.get(t, NEW_TEAM_PRIOR[1]) for t in teams}
        mo = sum(off.values()) / len(off) if off else 0
        md = sum(dfn.values()) / len(dfn) if dfn else 0
        return {
            "avg": round(self.avg + mo + md, 2), "hca": self.hca, "scale": self.scale, "sim": SIM,
            "absence": {"keyPlayers": ABSENCE["keyPlayers"], "perPlayer": ABSENCE["perPlayer"]},
            "paceBeta": PACE["beta"],
            "teams": {t: [round(off[t] - mo, 2), round(dfn[t] - md, 2)] for t in teams},
        }


def fit(games, teams, prior=None, as_of=None, *, prior_strength=PRIOR_STRENGTH,
        half_life=RECENCY_HALF_LIFE_DAYS, hca=HOME_ADVANTAGE, scale=LOGISTIC_SCALE):
    """
    games: simplified played games (only those before `as_of` are used)
    teams: team codes to rate
    prior: preseason Ratings from build_prior (or None), used as-is
    """
    if as_of is not None:
        games = [g for g in games if g["date"] < as_of]
    ref = as_of or (games[-1]["date"] if games else None)
    teams = sorted(teams)
    idx = {t: i for i, t in enumerate(teams)}
    n = len(teams)

    def weight(g):
        return 0.5 ** ((ref - g["date"]).days / half_life) if half_life else 1.0

    # league average: this season's games, blended with last season's average early on
    prior_avg = prior.avg if prior else DEFAULT_AVERAGE
    wsum = sum(2 * weight(g) for g in games)
    psum = sum(weight(g) * (g["hs"] + g["as"]) for g in games)
    k = 2 * n  # last season's average counts like two rounds of games
    avg = (psum + prior_avg * k) / (wsum + k)

    def prior_of(t):
        if prior and t in prior.off:
            return prior.off[t], prior.dfn[t]
        return NEW_TEAM_PRIOR

    # unknowns: offense[0..n-1], defense[n..2n-1]; normal equations A x = b
    size = 2 * n
    a = [[0.0] * size for _ in range(size)]
    b = [0.0] * size
    for t in teams:
        po, pd = prior_of(t)
        i = idx[t]
        a[i][i] += prior_strength
        b[i] += prior_strength * po
        a[n + i][n + i] += prior_strength
        b[n + i] += prior_strength * pd
    for g in games:
        if g["home"] not in idx or g["away"] not in idx:
            continue
        w = weight(g)
        h = 0 if g["neutral"] else hca / 2
        hi, ai = idx[g["home"]], idx[g["away"]]
        # home points = avg + h + off[home] + def[away]; away points = avg - h + off[away] + def[home]
        for off_i, def_j, y in ((hi, n + ai, g["hs"] - avg - h), (ai, n + hi, g["as"] - avg + h)):
            a[off_i][off_i] += w
            a[def_j][def_j] += w
            a[off_i][def_j] += w
            a[def_j][off_i] += w
            b[off_i] += w * y
            b[def_j] += w * y
    x = _solve(a, b)
    return Ratings(avg, {t: x[idx[t]] for t in teams}, {t: x[n + idx[t]] for t in teams}, hca, scale)


# Shooting luck (python backtest.py --luck). Three-point and free-throw percentages swing a lot from game
# to game and mostly by chance, so ratings are fitted on scores with part of that luck taken out:
#   points - three * 3 * (3PM - 3PA * league 3P%) - free * (FTM - FTA * league FT%)
LUCK = {"three": 0.0, "free": 0.0}


def luck_adjusted(games, totals, three=None, free=None):
    """games (simplify_games) -> copies with shooting luck partly removed from the scores.
    totals: game code -> compact_totals; games without totals stay as they are.
    League percentages are this season's so far (only earlier games)."""
    three = LUCK["three"] if three is None else three
    free = LUCK["free"] if free is None else free
    if not three and not free:
        return games
    made = [0.0, 0.0, 0.0, 0.0]  # 3PM, 3PA, FTM, FTA so far
    out = []
    for g in games:
        t = totals.get(g["code"])
        if not t:
            out.append(g)
            continue
        p3 = made[0] / made[1] if made[1] > 500 else 0.355
        pft = made[2] / made[3] if made[3] > 500 else 0.77
        adj = []
        for side in ("home", "away"):
            _, _, m3, a3, mft, aft, *_ = t[side]
            adj.append(-three * 3 * (m3 - a3 * p3) - free * (mft - aft * pft))
        out.append({**g, "hs": g["hs"] + adj[0], "as": g["as"] + adj[1]})
        for side in ("home", "away"):
            _, _, m3, a3, mft, aft, *_ = t[side]
            made[0] += m3; made[1] += a3; made[2] += mft; made[3] += aft
    return out


# Pace (python backtest.py --pace). A team's pace = its games' possessions above the league average so far,
# shrunk toward the league with `shrink` games of weight. The ratings already predict points; fast or slow
# teams add beta * (home pace + away pace) points to the predicted total (the margin doesn't change).
# Off (beta 0) until measured on LKL seasons (python backtest.py --pace).
PACE = {"beta": 0.0, "shrink": 5}


def possessions(t):
    """compact_totals side -> possessions"""
    return t[1] + t[3] + 0.44 * t[5] - t[6] + t[8]


class Pace:
    def __init__(self, shrink=None):
        self.k = PACE["shrink"] if shrink is None else shrink
        self.sum, self.n, self.league = {}, {}, []

    def league_pace(self):
        return sum(self.league) / len(self.league) if len(self.league) >= 5 else 76.0

    def team(self, team):
        lg = self.league_pace()
        return (self.sum.get(team, 0) + self.k * lg) / (self.n.get(team, 0) + self.k) - lg

    def add(self, home, away, totals):
        p = (possessions(totals["home"]) + possessions(totals["away"])) / 2
        self.league.append(p)
        for t in (home, away):
            self.sum[t] = self.sum.get(t, 0) + p
            self.n[t] = self.n.get(t, 0) + 1


class Availability:
    """
    Follows a season game by game and knows, before each game, every team's regulars and their value.
        av = Availability(history_player_totals(last season))
        av.key_players_out(team, players_who_play)   # before the game
        av.add(team, box_lines)                      # after it: [[player code, seconds, PIR], ...]
    """

    def __init__(self, last_season=None, min_games=None, min_share=None, prior_games=None):
        """last_season: player code -> (games, minutes, PIR) last season, from history_player_totals"""
        self.min_games = ABSENCE["minGames"] if min_games is None else min_games
        self.min_share = ABSENCE["minShare"] if min_share is None else min_share
        self.prior_games = ABSENCE["priorGames"] if prior_games is None else prior_games
        self.prior = {c: pir / n for c, (n, _, pir) in (last_season or {}).items() if n >= 5}
        self.team_games = {}
        self.stats = {}        # (team, player) -> [games, PIR]
        self.last_played = {}  # team -> players who played its latest game

    def value(self, team, player):
        """PIR per game, leaning on last season's early on"""
        n, pir = self.stats[(team, player)]
        if player in self.prior:
            k = self.prior_games
            return (pir + k * self.prior[player]) / (n + k)
        return pir / n

    def regulars(self, team):
        """-> {player: value} for players who played at least minShare of the team's games"""
        tg = self.team_games.get(team, 0)
        if tg < self.min_games:
            return {}
        return {c: self.value(t, c) for (t, c), (n, _) in self.stats.items()
                if t == team and n >= self.min_games and n / tg >= self.min_share}

    def key_players(self, team, k=None):
        regs = self.regulars(team)
        return sorted(regs, key=lambda c: -regs[c])[:k or ABSENCE["keyPlayers"]]

    def key_players_out(self, team, playing, k=None):
        return sum(c not in playing for c in self.key_players(team, k))

    def add(self, team, lines):
        self.team_games[team] = self.team_games.get(team, 0) + 1
        for c, secs, pir in lines:
            if secs > 0:
                st = self.stats.setdefault((team, c), [0, 0.0])
                st[0] += 1
                st[1] += pir
        self.last_played[team] = {c for c, secs, _ in lines if secs > 0}


def absence_effect(home_out, away_out, per_player=None):
    """key players out -> (home points change, away points change); the total stays the same"""
    d = (ABSENCE["perPlayer"] if per_player is None else per_player) * (away_out - home_out) / 2
    return d, -d


# Season forecast (python backtest.py --season). The rest of the regular season is played out `runs` times:
# every game's margin ~ normal(predicted margin + SIM bias, SIM sdMargin), and in each run every team's
# strength is also shifted by normal(0, ratingSd) points, because the ratings themselves are uncertain.
SEASON_SIM = {"runs": 10000, "ratingSd": 2.5}
PLAYOFF_PLACES = 8      # the top eight play for the title
RELEGATION_PLACES = 1   # the last team can be relegated


def simulate_season(ratings, teams, done, todo, runs=None, rating_sd=None, seed=2026):
    """
    done: [(home, away, home margin)] regular-season games already played
    todo: [(home, away)] regular-season games still to play
    -> team -> [P(finish 1-8: playoffs), P(finish last), expected final wins]
    Ties are ordered by wins, then point difference (the official head-to-head rule is not simulated).
    The seed is fixed so the same data always gives the same forecast.
    """
    runs = SEASON_SIM["runs"] if runs is None else runs
    rating_sd = SEASON_SIM["ratingSd"] if rating_sd is None else rating_sd
    rng = random.Random(seed)
    teams = sorted(teams)
    base_w = dict.fromkeys(teams, 0)
    base_d = dict.fromkeys(teams, 0.0)
    for h, a, m in done:
        base_w[h if m > 0 else a] += 1
        base_d[h] += m
        base_d[a] -= m
    pred = []
    for h, a in todo:
        hp, ap, _ = ratings.predict(h, a)
        pred.append((h, a, hp - ap + SIM["marginBias"]))
    sd = SIM["sdMargin"]
    out = {t: [0, 0, 0] for t in teams}
    for _ in range(runs):
        shift = {t: rng.gauss(0, rating_sd) for t in teams} if rating_sd else dict.fromkeys(teams, 0.0)
        w, d = dict(base_w), dict(base_d)
        for h, a, m in pred:
            x = m + shift[h] - shift[a] + rng.gauss(0, sd)
            w[h if x > 0 else a] += 1
            d[h] += x
            d[a] -= x
        for i, t in enumerate(sorted(teams, key=lambda t: (-w[t], -d[t]))):
            if i < PLAYOFF_PLACES:
                out[t][0] += 1
            elif i >= len(teams) - RELEGATION_PLACES:
                out[t][1] += 1
            out[t][2] += w[t]
    return {t: [v[0] / runs, v[1] / runs, v[2] / runs] for t, v in out.items()}


def season_teams(games):
    return {g["home"] for g in games} | {g["away"] for g in games}


# ---------- Past seasons (finished, so cached forever) ----------
HISTORY = Path(__file__).parent / ".cache" / "history"


def _cached(name, load):
    f = HISTORY / name
    if not f.exists():
        HISTORY.mkdir(parents=True, exist_ok=True)
        f.write_text(json.dumps(load()), encoding="utf-8")
    return json.loads(f.read_text(encoding="utf-8"))


def history_raw_games(season):
    """lkl.py game dicts for every game of a finished season"""
    return _cached(f"{season}.json", lambda: lkl.past_games(season))


def history_games(season):
    return simplify_games(history_raw_games(season))


def compact_box(box):
    """lkl.box() -> {"home": [[player code, seconds, PIR], ...], "away": [...]} (players listed for the game)"""
    return {side: [[p["code"], p["secs"], p["pir"]] for p in box[side]["players"]] for side in ("home", "away")}


def compact_totals(box):
    """lkl.box() -> {"home": [2PM, 2PA, 3PM, 3PA, FTM, FTA, OREB, DREB, TOV, PTS], "away": [...]}"""
    return {side: box[side]["total"][:10] for side in ("home", "away")}


def _history_boxes(season):
    """game code -> lkl.box() for the played games of a finished season (lkl.lt has no statistics for a few
    old games; those are left out). Each game is saved as soon as it is downloaded, so an interrupted
    download resumes."""
    folder = HISTORY / f"boxes_{season}"
    folder.mkdir(parents=True, exist_ok=True)

    def one(code):
        f = folder / f"{code}.json"
        if not f.exists():
            f.write_text(json.dumps(lkl.box(code)), encoding="utf-8")
        return code, json.loads(f.read_text(encoding="utf-8"))

    codes = [g["code"] for g in history_games(season)]
    missing = sum(not (folder / f"{c}.json").exists() for c in codes)
    if missing:
        print(f"  downloading {missing} box scores of {season}...", flush=True)
    with ThreadPoolExecutor(2) as pool:
        return {code: box for code, box in pool.map(one, codes) if box}


def history_boxes(season):
    """game code -> compact box score, for the played games of a finished season"""
    return {code: compact_box(box) for code, box in _history_boxes(season).items()}


def history_team_totals(season):
    """game code -> team totals (compact_totals) for the played games of a finished season"""
    return {code: compact_totals(box) for code, box in _history_boxes(season).items()}


def _player_lines(season):
    """-> [[player code, club id, games, seconds played, total PIR]], added up from the season's box scores"""
    def load():
        lines = {}
        for box in _history_boxes(season).values():
            for side in ("home", "away"):
                for p in box[side]["players"]:
                    if p["secs"] > 0:
                        line = lines.setdefault((p["code"], box[side]["club"]), [p["code"], box[side]["club"], 0, 0, 0])
                        line[2] += 1
                        line[3] += p["secs"]
                        line[4] += p["pir"]
        return list(lines.values())
    return _cached(f"players_{season}.json", load)


def history_players(season):
    """-> list of (player code, team code, games, total PIR) for a finished season"""
    return [(code, team, games, pir) for code, team, games, _, pir in _player_lines(season)]


def history_player_totals(season):
    """player code -> (games, minutes, PIR) over a finished season (all clubs)"""
    out = {}
    for code, _, games, secs, pir in _player_lines(season):
        n, mins, total = out.get(code, (0, 0.0, 0.0))
        out[code] = (n + games, mins + secs / 60, total + pir)
    return out


def history_roster(season):
    """team -> player codes that played at least 5 games for it"""
    roster = {}
    for code, team, games, _ in history_players(season):
        if games >= 5:
            roster.setdefault(team, set()).add(code)
    return roster


def previous(season):
    return lkl.previous(season)


# ---------- Preseason prior ----------
def build_prior(last, last_players, roster, *, carryover=CARRYOVER, talent_weight=TALENT_WEIGHT):
    """
    last:         Ratings at the end of last season
    last_players: history_players(last season)
    roster:       team -> player codes on this season's roster
    Prior = last season's rating * carryover
          + talent_weight * (last-season PIR of players who arrived - of players who left) / 1000
    The roster change is counted against the league's average change: most newcomers arrive from other
    leagues and have no LKL PIR, while everyone who leaves counts, so on its own it is negative
    for nearly every team.
    """
    pir = {}
    old_roster = {}
    for code, team, _, p in last_players:  # a player who changed clubs during the season has two lines
        pir[code] = pir.get(code, 0) + p
        old_roster.setdefault(team, set()).add(code)
    changes = {}
    for team, players in roster.items():
        old = old_roster.get(team, set())
        changes[team] = (sum(pir.get(c, 0) for c in players - old) - sum(pir.get(c, 0) for c in old - players)) / 1000
    usual = sum(changes.values()) / len(changes) if changes else 0
    off, dfn = {}, {}
    for team in roster:
        change = changes[team] - usual
        o, d = (last.off[team] * carryover, last.dfn[team] * carryover) if team in last.off else NEW_TEAM_PRIOR
        off[team] = o + talent_weight * change / 2
        dfn[team] = d - talent_weight * change / 2
    return Ratings(last.avg, off, dfn, last.hca, last.scale)


def preseason_prior(season, roster, **params):
    """Prior for `season` from the two previous seasons and this season's roster."""
    p1, p2 = previous(season), previous(previous(season))
    fit_params = {k: v for k, v in params.items() if k not in ("carryover", "talent_weight")}
    prior_params = {k: v for k, v in params.items() if k in ("carryover", "talent_weight")}
    g2, g1 = history_games(p2), history_games(p1)
    r2 = fit(g2, season_teams(g2), None, **fit_params)
    r1_prior = build_prior(r2, history_players(p2), history_roster(p1), **prior_params)
    r1 = fit(g1, season_teams(g1), r1_prior, **fit_params)
    return build_prior(r1, history_players(p1), roster, **prior_params)
