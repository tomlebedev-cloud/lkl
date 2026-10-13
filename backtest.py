"""
Measure prediction accuracy on past seasons.

    python backtest.py          # compare old vs current model
    python backtest.py --tune   # search model parameters (tuned on 2023-24 + 2024-25, checked on 2025-26)
    python backtest.py --spread # how far results land from predictions (model.SIM, used by the betting page)
    python backtest.py --absences  # effect of missing players (model.ABSENCE); downloads box scores once
    python backtest.py --luck   # take shooting luck out of the ratings (model.LUCK); downloads team totals once
    python backtest.py --pace   # pace adjustment of predicted totals (model.PACE)
    python backtest.py --season # season forecast (model.SEASON_SIM): chances of the playoffs / finishing last
    python backtest.py --promoted  # how promoted teams did (model.NEW_TEAM_PRIOR)

Every game is predicted using only games played before it, exactly like the website does live.
Past seasons are downloaded once into .cache/history/.
"""

import itertools
import math
import statistics
import sys
from collections import defaultdict

import model

ALL_SEASONS = ["2021", "2022", "2023", "2024", "2025"]  # named by the year they start in
TEST_SEASONS = ["2023", "2024", "2025"]  # each needs the two seasons before it
TUNE_SEASONS = ["2023", "2024"]
CHECK_SEASONS = ["2025"]

SEASONS = {s: model.history_games(s) for s in ALL_SEASONS}


# ---------- the old website model, for comparison ----------
def old_model_predictions(games):
    out = []
    pf, pa, gp = defaultdict(float), defaultdict(float), defaultdict(int)
    played = []
    for date, day in itertools.groupby(games, key=lambda g: g["date"].date()):
        day = list(day)
        avg = sum(g["hs"] + g["as"] for g in played) / (2 * len(played)) if played else 82
        for g in day:
            r = {}
            for t in (g["home"], g["away"]):
                r[t] = ((pf[t] + avg * 2) / (gp[t] + 2), (pa[t] + avg * 2) / (gp[t] + 2))
            hp = (r[g["home"]][0] + r[g["away"]][1]) / 2 + 1.5
            ap = (r[g["away"]][0] + r[g["home"]][1]) / 2 - 1.5
            out.append((g, hp - ap, 1 / (1 + math.exp(-(hp - ap) / 6))))
        for g in day:
            pf[g["home"]] += g["hs"]; pa[g["home"]] += g["as"]; gp[g["home"]] += 1
            pf[g["away"]] += g["as"]; pa[g["away"]] += g["hs"]; gp[g["away"]] += 1
            played.append(g)
    return out


# ---------- the new model ----------
def new_model_margins(season, **params):
    """-> list of (game, predicted margin) for every game in the season"""
    prior = model.preseason_prior(season, model.history_roster(season), **params)
    fit_params = {k: v for k, v in params.items() if k not in ("carryover", "talent_weight")}
    games = SEASONS[season]
    teams = model.season_teams(games)
    out = []
    for date, day in itertools.groupby(games, key=lambda g: g["date"].date()):
        day = list(day)
        r = model.fit(games, teams, prior, as_of=day[0]["date"].replace(hour=0, minute=0), **fit_params)
        for g in day:
            hp, ap, _ = r.predict(g["home"], g["away"], g["neutral"])
            out.append((g, hp - ap))
    return out


def with_probs(margins, scale):
    return [(g, m, 1 / (1 + math.exp(-m / scale))) for g, m in margins]


def best_scale(margins):
    def ll(s):
        return log_loss(with_probs(margins, s))
    return min((s / 10 for s in range(40, 160)), key=ll)


# ---------- metrics ----------
def log_loss(preds):
    tot = 0
    for g, _, p in preds:
        p = min(max(p, 1e-6), 1 - 1e-6)
        tot -= math.log(p if g["hs"] > g["as"] else 1 - p)
    return tot / len(preds)


def metrics(preds):
    n = len(preds)
    correct = sum((m > 0) == (g["hs"] > g["as"]) for g, m, _ in preds)
    brier = sum((p - (g["hs"] > g["as"])) ** 2 for g, _, p in preds) / n
    mae = sum(abs(m - (g["hs"] - g["as"])) for g, m, _ in preds) / n
    return {"games": n, "accuracy": correct / n, "log_loss": log_loss(preds), "brier": brier, "margin_error": mae}


def fmt(m):
    return (f"{m['games']:4d} games  winner right {m['accuracy']:6.1%}  log loss {m['log_loss']:.3f}  "
            f"Brier {m['brier']:.3f}  margin error {m['margin_error']:4.1f} pts")


def early(preds, k=80):
    return preds[:k]  # first ~9 rounds


def report(seasons):
    for s in seasons:
        old = old_model_predictions(SEASONS[s])
        new = with_probs(new_model_margins(s), model.LOGISTIC_SCALE)
        print(f"\nseason {s}-{(int(s) + 1) % 100:02d}")
        print("  old model, all games  ", fmt(metrics(old)))
        print("  new model, all games  ", fmt(metrics(new)))
        print("  old model, first 80   ", fmt(metrics(early(old))))
        print("  new model, first 80   ", fmt(metrics(early(new))))
    old_all = [p for s in seasons for p in old_model_predictions(SEASONS[s])]
    new_all = [p for s in seasons for p in with_probs(new_model_margins(s), model.LOGISTIC_SCALE)]
    print("\nALL SEASONS")
    print("  old model ", fmt(metrics(old_all)))
    print("  new model ", fmt(metrics(new_all)))
    print("  always pick home team: winner right "
          f"{sum(g['hs'] > g['as'] for g, _, _ in new_all) / len(new_all):.1%}")


def tune():
    grid = {
        "prior_strength": [10, 20, 30],
        "carryover": [0.55, 0.7, 0.85, 1.0],
        "talent_weight": [0, 1.0, 2.0, 3.0],
        "half_life": [240, 0],
        "hca": [2.8, 3.4, 4.0],
    }
    results = []
    for values in itertools.product(*grid.values()):
        params = dict(zip(grid.keys(), values))
        margins = [x for s in TUNE_SEASONS for x in new_model_margins(s, **params)]
        scale = best_scale(margins)
        results.append((log_loss(with_probs(margins, scale)), scale, params))
        print(f"  {results[-1][0]:.4f}  scale {scale:4.1f}  {params}", flush=True)
    results.sort(key=lambda r: r[0])
    print("\nBest 5 on", TUNE_SEASONS)
    for r in results[:5]:
        print(f"  {r[0]:.4f}  scale {r[1]:4.1f}  {r[2]}")
    ll, scale, params = results[0]
    check = with_probs([x for s in CHECK_SEASONS for x in new_model_margins(s, **params)], scale)
    print("\nBest parameters on unseen season", CHECK_SEASONS, ":", fmt(metrics(check)))


def spread():
    """Residuals of predicted margin and total, for model.SIM."""
    dm, dt = [], []
    for s in TEST_SEASONS:
        prior = model.preseason_prior(s, model.history_roster(s))
        games = SEASONS[s]
        teams = model.season_teams(games)
        for date, day in itertools.groupby(games, key=lambda g: g["date"].date()):
            day = list(day)
            r = model.fit(games, teams, prior, as_of=day[0]["date"].replace(hour=0, minute=0))
            for g in day:
                hp, ap, _ = r.predict(g["home"], g["away"], g["neutral"])
                dm.append(g["hs"] - g["as"] - (hp - ap))
                dt.append(g["hs"] + g["as"] - (hp + ap))
    print(f"{len(dm)} games")
    print(f"  margin: bias {statistics.mean(dm):+.2f}  sd {statistics.pstdev(dm):.2f}")
    print(f"  total:  bias {statistics.mean(dt):+.2f}  sd {statistics.pstdev(dt):.2f}")
    print(f"  correlation {statistics.correlation(dm, dt):.3f}")
    print(f"  total points mean abs error: model {statistics.mean(map(abs, dt)):.2f}")
    print(f"  currently in model.SIM: {model.SIM}")


# ---------- missing players ----------
_PRED = {}


def season_predictions(season):
    """-> [(game, predicted home points, predicted away points)], each made before the game"""
    if season not in _PRED:
        prior = model.preseason_prior(season, model.history_roster(season))
        games = SEASONS[season]
        teams = model.season_teams(games)
        out = []
        for date, day in itertools.groupby(games, key=lambda g: g["date"].date()):
            day = list(day)
            r = model.fit(games, teams, prior, as_of=day[0]["date"].replace(hour=0, minute=0))
            out += [(g, *r.predict(g["home"], g["away"], g["neutral"])[:2]) for g in day]
        _PRED[season] = out
    return _PRED[season]


def absence_rows(season, k=None, known="actual"):
    """-> [(game, home pts, away pts, home key players out, away key players out)].
    known="actual":   who really played, like knowing the line-ups before tip-off
    known="previous": who played the team's previous game, all the site knows without injury news"""
    boxes = model.history_boxes(season)
    av = model.Availability(model.history_player_totals(model.previous(season)))
    out = {}
    for g in SEASONS[season]:
        box = boxes.get(g["code"])
        if not box:  # lkl.lt has no statistics for this game: nobody is counted out
            out[g["code"]] = (0, 0)
            continue
        if known == "actual":
            playing = {side: {c for c, secs, _ in box[side] if secs > 0} for side in ("home", "away")}
        else:  # a team's first game: nobody is assumed out
            playing = {side: av.last_played.get(g[side], set(av.key_players(g[side], k)))
                       for side in ("home", "away")}
        out[g["code"]] = (av.key_players_out(g["home"], playing["home"], k),
                          av.key_players_out(g["away"], playing["away"], k))
        av.add(g["home"], box["home"])
        av.add(g["away"], box["away"])
    return [(g, hp, ap, *out[g["code"]]) for g, hp, ap in season_predictions(season)]


def fit_absence(rows):
    """least squares: margin error = -per_player * (home key players out - away key players out)"""
    bias = model.SIM["marginBias"]
    xs = [ho - ao for _, _, _, ho, ao in rows]
    ys = [g["hs"] - g["as"] - (hp - ap) - bias for g, hp, ap, _, _ in rows]
    return -sum(x * y for x, y in zip(xs, ys)) / sum(x * x for x in xs)


def absence_metrics(rows, per_player):
    sim = model.SIM
    dist = statistics.NormalDist()
    ll = mae = right = 0.0
    for g, hp, ap, ho, ao in rows:
        dh, da = model.absence_effect(ho, ao, per_player)
        m = hp + dh - ap - da
        mae += abs(g["hs"] - g["as"] - m)
        right += (m + sim["marginBias"] > 0) == (g["hs"] > g["as"])
        p = min(max(dist.cdf((m + sim["marginBias"]) / sim["sdMargin"]), 1e-6), 1 - 1e-6)
        ll -= math.log(p if g["hs"] > g["as"] else 1 - p)
    n = len(rows)
    return {"log_loss": ll / n, "margin_error": mae / n, "accuracy": right / n}


def absences():
    """Each season is predicted with the effect measured on the other two (leave one season out)."""
    for k in (1, 2, 3, 4):
        rows = {s: absence_rows(s, k) for s in TEST_SEASONS}
        line, effects = [], []
        for test in TEST_SEASONS:
            per = fit_absence([r for s in TEST_SEASONS if s != test for r in rows[s]])
            before, after = absence_metrics(rows[test], 0), absence_metrics(rows[test], per)
            effects.append(per)
            line.append(f"{test} log loss {before['log_loss']:.4f}->{after['log_loss']:.4f}")
        all_rows = [r for s in TEST_SEASONS for r in rows[s]]
        per = fit_absence(all_rows)
        before, after = absence_metrics(all_rows, 0), absence_metrics(all_rows, per)
        print(f"top {k}: {per:.2f} points per key player out (per season {', '.join(f'{e:.2f}' for e in effects)})")
        print(f"  {' | '.join(line)}")
        print(f"  all: winner right {before['accuracy']:.1%} -> {after['accuracy']:.1%}, "
              f"margin error {before['margin_error']:.2f} -> {after['margin_error']:.2f}")
    # the same effect applied with only "who missed the previous game" known
    per = model.ABSENCE["perPlayer"]
    for known in ("actual", "previous"):
        rows = [r for s in TEST_SEASONS for r in absence_rows(s, None, known)]
        before, after = absence_metrics(rows, 0), absence_metrics(rows, per)
        print(f"line-ups known from {known} game: measured effect {fit_absence(rows):.2f} points; with {per} "
              f"log loss {before['log_loss']:.4f} -> {after['log_loss']:.4f}")
    print(f"currently in model.ABSENCE: {model.ABSENCE}")


# ---------- shooting luck ----------
def luck_predictions(season, three, free):
    """-> [(game, home pts, away pts)] with ratings fitted on luck-adjusted scores (results stay real)"""
    prior = model.preseason_prior(season, model.history_roster(season))
    games = SEASONS[season]
    fit_games = model.luck_adjusted(games, model.history_team_totals(season), three, free)
    teams = model.season_teams(games)
    out = []
    for date, day in itertools.groupby(games, key=lambda g: g["date"].date()):
        day = list(day)
        r = model.fit(fit_games, teams, prior, as_of=day[0]["date"].replace(hour=0, minute=0))
        out += [(g, *r.predict(g["home"], g["away"], g["neutral"])[:2]) for g in day]
    return out


def luck_metrics(rows):
    sim, dist = model.SIM, statistics.NormalDist()
    ll = mae = tot = right = 0.0
    for g, hp, ap in rows:
        m = hp - ap
        mae += abs(g["hs"] - g["as"] - m)
        tot += abs(g["hs"] + g["as"] - (hp + ap) - sim["totalBias"])
        right += (m + sim["marginBias"] > 0) == (g["hs"] > g["as"])
        p = min(max(dist.cdf((m + sim["marginBias"]) / sim["sdMargin"]), 1e-6), 1 - 1e-6)
        ll -= math.log(p if g["hs"] > g["as"] else 1 - p)
    n = len(rows)
    return {"log_loss": ll / n, "margin_error": mae / n, "total_error": tot / n, "accuracy": right / n}


def luck():
    """Tuned on 2023-24 + 2024-25, checked on 2025-26."""
    results = []
    for three in (0, 0.25, 0.5, 0.75, 1.0):
        for free in (0, 0.5, 1.0):
            rows = [r for s in TUNE_SEASONS for r in luck_predictions(s, three, free)]
            m = luck_metrics(rows)
            results.append((m["log_loss"], three, free))
            print(f"  three {three:.2f} free {free:.1f}: log loss {m['log_loss']:.4f}, winners {m['accuracy']:.1%}, "
                  f"margin error {m['margin_error']:.2f}, total error {m['total_error']:.2f}", flush=True)
    _, three, free = min(results)
    print(f"\nBest on {TUNE_SEASONS}: three {three}, free {free}")
    for s in CHECK_SEASONS:
        before, after = luck_metrics(luck_predictions(s, 0, 0)), luck_metrics(luck_predictions(s, three, free))
        print(f"  unseen {s}: log loss {before['log_loss']:.4f} -> {after['log_loss']:.4f}, winners "
              f"{before['accuracy']:.1%} -> {after['accuracy']:.1%}, margin error {before['margin_error']:.2f} -> "
              f"{after['margin_error']:.2f}, total error {before['total_error']:.2f} -> {after['total_error']:.2f}")
    print(f"currently in model.LUCK: {model.LUCK}")


# ---------- pace ----------
def pace():
    """Total-points error with and without the pace adjustment; beta measured per season."""
    for s in TEST_SEASONS:
        totals = model.history_team_totals(s)
        pc = model.Pace()
        xs, ys = [], []
        for g, hp, ap in season_predictions(s):
            xs.append(pc.team(g["home"]) + pc.team(g["away"]))
            ys.append(g["hs"] + g["as"] - (hp + ap) - model.SIM["totalBias"])
            if g["code"] in totals:
                pc.add(g["home"], g["away"], totals[g["code"]])
        best = sum(x * y for x, y in zip(xs, ys)) / sum(x * x for x in xs)
        beta = model.PACE["beta"]
        before = statistics.mean(abs(y) for y in ys)
        after = statistics.mean(abs(y - beta * x) for x, y in zip(xs, ys))
        print(f"{s}: total error {before:.2f} -> {after:.2f} with beta {beta} (this season alone would pick {best:.2f})")
    print(f"currently in model.PACE: {model.PACE}")


# ---------- season forecast ----------
def season_rows(rating_sd, runs=1500, checkpoints=(0, 4, 10, 20)):
    """Forecast each past season before round 1 and after rounds 4, 10 and 20, and compare with how it ended.
    -> [(P playoffs, made the playoffs, P relegation, relegated, expected wins, wins, checkpoint)]"""
    top, last = model.PLAYOFF_PLACES, model.RELEGATION_PLACES
    rows = []
    for season in TEST_SEASONS:
        raw = sorted((g for g in model.history_raw_games(season) if g["phase"] == "RS"), key=lambda g: g["utc"])
        games = [(g["round"], g["home"], g["away"], g["score"][0] - g["score"][1], g["utc"]) for g in raw]
        teams = sorted({g[1] for g in games} | {g[2] for g in games})
        wins, diff = dict.fromkeys(teams, 0), dict.fromkeys(teams, 0)
        for _, h, a, m, _ in games:
            wins[h if m > 0 else a] += 1
            diff[h] += m
            diff[a] -= m
        order = sorted(teams, key=lambda t: (-wins[t], -diff[t]))
        prior = model.preseason_prior(season, model.history_roster(season))
        for cp in checkpoints:
            todo = [g for g in games if g[0] > cp]
            ratings = model.fit(SEASONS[season], teams, prior,
                                as_of=model.parse_date(todo[0][4]).replace(hour=0, minute=0))
            res = model.simulate_season(ratings, teams, [g[1:4] for g in games if g[0] <= cp],
                                        [g[1:3] for g in todo], runs, rating_sd, seed=cp)
            for t in teams:
                pos = order.index(t)
                rows.append((res[t][0], pos < top, res[t][1], pos >= len(teams) - last, res[t][2], wins[t], cp))
    return rows


def season():
    for sd in (0, 1.5, 2.5, 3.5, 4.5):
        rows = season_rows(sd)
        brier = lambda i, j: sum((r[i] - r[j]) ** 2 for r in rows) / len(rows)
        wins = {cp: statistics.mean(abs(r[4] - r[5]) for r in rows if r[6] == cp) for cp in (0, 4, 10, 20)}
        print(f"rating sd {sd}: Brier playoffs {brier(0, 1):.4f}, relegation {brier(2, 3):.4f}; final wins off by "
              + ", ".join(f"{v:.1f} after round {cp}" for cp, v in wins.items()), flush=True)
    rows = season_rows(model.SEASON_SIM["ratingSd"], runs=3000)
    print(f"\nCalibration with model.SEASON_SIM {model.SEASON_SIM}:")
    for name, i, j in (("playoffs", 0, 1), ("relegation", 2, 3)):
        for lo, hi in ((0, .1), (.1, .3), (.3, .5), (.5, .7), (.7, .9), (.9, 1.01)):
            sel = [r for r in rows if lo <= r[i] < hi]
            if sel:
                print(f"  {name}: forecast {lo:.0%}-{min(hi, 1):.0%} (average {statistics.mean(r[i] for r in sel):.0%}) "
                      f"happened {statistics.mean(r[j] for r in sel):.0%} of {len(sel)} times")


# ---------- promoted teams ----------
def promoted():
    """Ratings at the end of the season of teams that weren't in the league the season before."""
    offs, dfns = [], []
    for prev, s in zip(ALL_SEASONS, ALL_SEASONS[1:]):
        games = SEASONS[s]
        r = model.fit(games, model.season_teams(games), None, prior_strength=1.0, half_life=0)
        for t in sorted(model.season_teams(games) - model.season_teams(SEASONS[prev])):
            offs.append(r.off[t])
            dfns.append(r.dfn[t])
            print(f"  {s} team {t}: attack {r.off[t]:+.1f}, defence {r.dfn[t]:+.1f}")
    print(f"average of {len(offs)} promoted teams: attack {statistics.mean(offs):+.2f}, defence {statistics.mean(dfns):+.2f}")
    print(f"currently in model.NEW_TEAM_PRIOR: {model.NEW_TEAM_PRIOR}")


if __name__ == "__main__":
    if "--promoted" in sys.argv:
        promoted()
    elif "--tune" in sys.argv:
        tune()
    elif "--spread" in sys.argv:
        spread()
    elif "--absences" in sys.argv:
        absences()
    elif "--luck" in sys.argv:
        luck()
    elif "--pace" in sys.argv:
        pace()
    elif "--season" in sys.argv:
        season()
    else:
        report(TEST_SEASONS)
