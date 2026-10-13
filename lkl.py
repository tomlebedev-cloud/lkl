"""
LKL (Lithuanian Basketball League) data, read from lkl.lt.

    seasons()                  the seasons lkl.lt knows: "2026" -> its id on the site
    calendar()                 the running season: clubs and all games (schedule and results)
    box(game code)             one finished game: quarter scores and the full box score (lkl.lt's own JSON)
    player(slug)               a player's full name and position
    standings(clubs)           the official table
    past_games(season)         every game of a finished season

Seasons are named by the year they start in: "2026" is 2026-27. Clubs are identified by lkl.lt's
team id (Žalgiris is "3"), which stays the same when the sponsor in the name changes; players by the
name in their page address ("tauras-jogela").
Only uses the Python standard library.
"""

import html
import json
import re
import time
import unicodedata
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta

SITE = "https://lkl.lt"

# Everyday club names (lkl.lt uses the sponsor names) and home cities: team id -> (name, city)
CLUBS = {
    "3": ("Žalgiris", "Kaunas"),
    "4": ("Juventus", "Utena"),
    "5": ("Neptūnas", "Klaipėda"),
    "6": ("Rytas", "Vilnius"),
    "10": ("Lietkabelis", "Panevėžys"),
    "11": ("Nevėžis", "Kėdainiai"),
    "12": ("Šiauliai", "Šiauliai"),
    "41": ("Jonava", "Jonava"),
    "60": ("Gargždai", "Gargždai"),
    "61": ("Tauragė", "Tauragė"),
}

POSITIONS = {"Įžaidėjas": "Point guard", "Gynėjas": "Guard", "Atakuojantis gynėjas": "Shooting guard",
             "Puolėjas": "Forward", "Lengvasis krašto puolėjas": "Small forward",
             "Sunkusis krašto puolėjas": "Power forward", "Vidurio puolėjas": "Center", "Centras": "Center"}

MONTHS = {m: i + 1 for i, m in enumerate(
    ["sausio", "vasario", "kovo", "balandžio", "gegužės", "birželio", "liepos", "rugpjūčio", "rugsėjo",
     "spalio", "lapkričio", "gruodžio"])}


def previous(season):
    return str(int(season) - 1)


def to_utc(local):
    """'2026-10-17T16:30:00' on a clock in Lithuania -> '2026-10-17T13:30:00Z'"""
    t = datetime.fromisoformat(local)

    def last_sunday(month):  # summer time runs from the last Sunday of March to the last Sunday of October
        d = datetime(t.year, month, 31, 3)
        return d - timedelta(days=(d.weekday() + 1) % 7)

    summer = last_sunday(3) <= t < last_sunday(10)
    return (t - timedelta(hours=3 if summer else 2)).isoformat() + "Z"


def slugify(name):
    """'Nevėžis-Paskolų klubas' -> 'nevezis-paskolu-klubas', the way lkl.lt writes page addresses"""
    plain = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", plain.lower()).strip("-")


# ---------- downloading ----------
def fetch(url, attempts=12):
    """GET a page, waiting and retrying when the site is busy or the connection drops."""
    req = urllib.request.Request(url, headers={"User-Agent": "lkl-hub", "X-Requested-With": "XMLHttpRequest"})
    for i in range(attempts):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.read().decode("utf-8")
        except urllib.error.HTTPError as e:
            if e.code not in (429, 500, 502, 503, 504) or i == attempts - 1:
                raise
            wait = int(e.headers.get("Retry-After") or 30)
            print(f"  lkl.lt is busy ({e.code}), waiting {wait}s...", flush=True)
            time.sleep(wait + 1)
        except (urllib.error.URLError, TimeoutError) as e:
            if i == attempts - 1:
                raise
            print(f"  connection problem ({e}), retrying in 20s...", flush=True)
            time.sleep(20)


def seasons():
    """-> {"2026": 49436, ...}: the id lkl.lt gives each LKL season, newest first"""
    page = fetch(f"{SITE}/rezultatai")
    select = re.search(r'<select id="season-lkl".*?</select>', page, re.S).group(0)
    return {m.group(2): int(m.group(1))
            for m in re.finditer(r'<option value="(\d+)"[^>]*>\s*(\d{4})-\d{4}', select)}


# ---------- lists of games ----------
_ITEM = re.compile(
    r'(?P<day>(?P<y>\d{4}) m\. (?P<mon>\w+) (?P<d>\d+) d\.)'
    r'|class="result-item">(?P<item>.*?)(?=class="result-item">|class="font-semibold text-2xl|class="lkl-paginator|$)',
    re.S)


def _games_page(kind, season_id, page):
    """One page of lkl.lt's results ("loadResults") or schedule ("loadSchedule") -> (games, last page number)"""
    text = fetch(f"{SITE}/{kind}?season={season_id}&team=-&opponent=-&month=-&page={page}")
    games, day = [], None
    for m in _ITEM.finditer(text):
        if m.group("day"):
            if m.group("mon") in MONTHS:
                day = f"{m.group('y')}-{MONTHS[m.group('mon')]:02d}-{int(m.group('d')):02d}"
            continue
        item = m.group("item")
        code = re.search(r"/rungtynes/(\d+)", item)
        teams = re.findall(r"/komandos/([a-z0-9-]+)", item)
        clock = re.search(r"(\d\d):(\d\d)", item)
        if not (code and day and len(teams) >= 2):
            continue
        where = re.search(r'text-lg font-bold">.*?</div>\s*<div>(.*?)</div>', item, re.S)
        venue = re.sub(r"\s*,\s*", ", ", " ".join(html.unescape(where.group(1)).split())) if where else ""
        link = re.search(r'/rungtynes/\d+"[^>]*>(.*?)</a>', item, re.S)
        nums = re.findall(r"\d+", re.sub(r"<[^>]+>", " ", link.group(1))) if link else []
        local = f"{day}T{clock.group(1)}:{clock.group(2)}:00" if clock else f"{day}T19:00:00"
        games.append({"code": int(code.group(1)), "local": local, "utc": to_utc(local), "venue": venue,
                      "home": teams[0], "away": teams[-1],
                      "score": [int(nums[0]), int(nums[1])] if kind == "loadResults" and len(nums) >= 2 else None})
    pages = [int(p) for p in re.findall(r"[?&]page=(\d+)", text)]
    return games, max(pages, default=1)


def _all_games(kind, season_id):
    first, last = _games_page(kind, season_id, 1)
    with ThreadPoolExecutor(2) as pool:
        rest = pool.map(lambda p: _games_page(kind, season_id, p)[0], range(2, last + 1))
        return first + [g for page in rest for g in page]


def game_teams(code):
    """A finished game's page names both teams:
    -> {"home"/"away": {"id", "name", "short_name", "slug", "logo", "coach", ...}}"""
    m = re.search(r':teams-info="([^"]*)"', fetch(f"{SITE}/rungtynes/{code}"))
    return json.loads(html.unescape(m.group(1))) if m else {}


def _season_games(season_id):
    """-> (clubs by page name, games) with clubs still named by their page name ("zalgiris") in the games"""
    played = _all_games("loadResults", season_id)
    coming = [g for g in _all_games("loadSchedule", season_id) if g["code"] not in {p["code"] for p in played}]
    # who is who: one finished game per club tells its id, names, logo and coach (latest game first)
    clubs = {}
    for g in sorted(played, key=lambda g: g["local"], reverse=True):
        if g["home"] in clubs and g["away"] in clubs:
            continue
        for t in game_teams(g["code"]).values():
            clubs.setdefault(t["slug"], t)
    return clubs, played, coming


def _finish(clubs, games):
    """Page names -> club ids; mark playoff games; number the rounds."""
    ids = {slug: str(t["id"]) for slug, t in clubs.items()}
    games = [g for g in games if g["home"] in ids and g["away"] in ids]
    for g in games:
        g["home"], g["away"] = ids[g["home"]], ids[g["away"]]
        g["played"] = g["score"] is not None
    games.sort(key=lambda g: (g["local"], g["code"]))
    # The regular season is a round robin: every pair meets the same number of times. Later meetings of a
    # pair are playoff games.
    meetings = {}
    for g in games:
        pair = frozenset((g["home"], g["away"]))
        meetings[pair] = meetings.get(pair, 0) + 1
    teams = {t for g in games for t in (g["home"], g["away"])}
    full = len(meetings) == len(teams) * (len(teams) - 1) // 2
    rounds = min(meetings.values()) if meetings and full else 99
    seen, weeks = {}, {}
    for g in games:
        pair = frozenset((g["home"], g["away"]))
        seen[pair] = seen.get(pair, 0) + 1
        g["phase"] = "RS" if seen[pair] <= rounds else "PO"
        # lkl.lt doesn't number rounds: a round here is one week of games, Monday to Sunday
        day = datetime.fromisoformat(g["local"])
        week = (day - timedelta(days=day.weekday())).date()
        g["round"] = weeks.setdefault(week, len(weeks) + 1)
    return games


def club_info(t):
    code = str(t["id"])
    name, city = CLUBS.get(code, (t["name"], ""))
    return {"id": code, "short": t["short_name"], "name": name, "fullName": t["name"], "city": city,
            "country": "Lithuania", "crest": (t.get("logo") or "").replace("http://", "https://"),
            "coach": t.get("coach") or "", "slug": t["slug"]}


def calendar():
    """-> (season, clubs, games) of the season lkl.lt is showing now.
    clubs: club id -> {"id", "short", "name", "fullName", "city", "country", "crest", "coach", "slug"}
    games: [{"code", "round", "utc", "local", "venue", "home", "away", "played", "score", "phase"}]
    """
    season, season_id = next(iter(seasons().items()))
    clubs, played, coming = _season_games(season_id)
    # a club that hasn't played yet this season: its id comes from the team list on the results page
    missing = {t for g in coming for t in (g["home"], g["away"])} - set(clubs)
    if missing:
        page = fetch(f"{SITE}/rezultatai")
        select = re.search(r'<select[^>]*id="team-lkl".*?</select>', page, re.S).group(0)
        for tid, name in re.findall(r'<option value="(\d+)"[^>]*>\s*([^<]+?)\s*<', select):
            name = html.unescape(name)
            if slugify(name) in missing:
                clubs[slugify(name)] = {"id": int(tid), "name": name, "short_name": name[:3].upper(),
                                        "slug": slugify(name), "logo": "", "coach": ""}
    games = _finish(clubs, played + coming)
    return season, {str(t["id"]): club_info(t) for t in clubs.values()}, games


def past_games(season):
    """Every played game of a finished season (regular season and playoffs), same shape as calendar()'s games."""
    clubs, played, _ = _season_games(seasons()[season])
    return _finish(clubs, played)


def standings(clubs):
    """-> club id -> [position, games played, games won], in the league's official order"""
    ids = {c["slug"]: code for code, c in clubs.items()}
    page = fetch(f"{SITE}/turnyrine-lentele")
    table = page[page.find("standings-table"):]
    table = table[:table.find("</table>")]  # the first table is the overall one
    out = {}
    for row in table.split("<tr")[1:]:
        slug = re.search(r"/komandos/([a-z0-9-]+)", row)
        nums = re.findall(r'class="num[^"]*"[^>]*>\s*([\d.]+)\s*<', row)
        if slug and slug.group(1) in ids and len(nums) >= 3:
            out[ids[slug.group(1)]] = [int(nums[0]), int(nums[1]), int(nums[2])]
    return out


# ---------- box scores ----------
def seconds(play_time):
    """'18:41' -> 1121"""
    try:
        m, s = (play_time or "0:0").split(":")[-2:]
        return int(m) * 60 + int(s)
    except ValueError:
        return 0


def _made(cell):
    """{"value": "3/8"} -> (3, 8)"""
    try:
        made, tried = str((cell or {}).get("value") or "0/0").split("/")
        return int(made), int(tried)
    except ValueError:
        return 0, 0


def box(code):
    """One game's statistics, cut down to what the site and the model use (None if lkl.lt has none):
    {"played", "score": [home, away], "quarters": [[home...], [away...]],
     "home"/"away": {"club", "total": [2PM, 2PA, 3PM, 3PA, FTM, FTA, OREB, DREB, TOV, PTS, AST, STL, BLK],
                     "players": [{"code", "name", "num", "secs", "pts", "reb", "ast", "stl", "blk", "pir",
                                  "m2", "a2", "m3", "a3", "mf", "af", "tov", "pm"}]}}
    """
    data = json.loads(fetch(f"{SITE}/api/livestream/boxscore/{code}"))
    stats, lines = data.get("gameStatistics") or {}, data.get("boxscore") or {}
    if len(stats) != 2 or any(s.get("points") is None for s in stats.values()) or "home" not in lines:
        return None
    first, second = stats.values()  # the home team comes first; the team totals say so too
    if (lines["home"]["team"]["points"]["value"], lines["away"]["team"]["points"]["value"]) == \
            (second["points"], first["points"]) and first["points"] != second["points"]:
        first, second = second, first
    out = {"played": True, "score": [first["points"], second["points"]], "quarters": []}
    for side, s in (("home", first), ("away", second)):
        q = s.get("quarter_scores") or {}
        out["quarters"].append([q[k] for k in sorted(q, key=int)] if isinstance(q, dict) else list(q))
        players = []
        for p in lines[side]["players"]:
            val = lambda k: (p.get(k) or {}).get("value") or 0
            (m2, a2), (m3, a3), (mf, af) = _made(p.get("fg2")), _made(p.get("fg3")), _made(p.get("ft"))
            players.append({
                "code": p.get("slug") or slugify(val("name") or "?"), "name": val("name"),
                "num": str((p.get("jersey") or {}).get("value") or ""),
                "secs": seconds((p.get("time") or {}).get("value")),
                "pts": val("points"), "reb": val("total_rebounds"), "ast": val("assists"), "stl": val("steals"),
                "blk": val("blocks"), "pir": val("efficiency"), "m2": m2, "a2": a2, "m3": m3, "a3": a3,
                "mf": mf, "af": af, "tov": val("turnovers"), "pm": val("plus_minus")})
        total = [s.get(k) or 0 for k in (
            "field_goals_made_2pt", "field_goals_attempted_2pt", "field_goals_made_3pt", "field_goals_attempted_3pt",
            "free_throws_made", "free_throws_attempted", "offensive_rebounds", "defensive_rebounds", "turnovers",
            "points", "assists", "steals", "blocks")]
        out[side] = {"club": str(s["team_id"]), "total": total, "players": players}
    return out


def player(slug):
    """-> {"name": "Tauras Jogėla", "pos": "Forward"} from the player's page"""
    try:
        page = fetch(f"{SITE}/zaidejai/{slug}", attempts=3)
    except urllib.error.HTTPError:
        return {"name": slug.replace("-", " ").title(), "pos": ""}
    title = re.search(r"<title>\s*(.*?)\s*-\s*LKL", page, re.S)
    name = html.unescape(title.group(1)).strip() if title else slug.replace("-", " ").title()
    pos = next((en for lt, en in sorted(POSITIONS.items(), key=lambda x: -len(x[0])) if f">{lt}<" in re.sub(r">\s+", ">", re.sub(r"\s+<", "<", page))), "")
    return {"name": name, "pos": pos}
