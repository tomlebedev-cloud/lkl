# LKL Hub

A simple LKL (Lithuanian Basketball League) website with real data: teams, players, statistics, schedule and
predictions. English or Lithuanian (EN / LT switch in the header, remembered by the browser).
Plain HTML, CSS and JavaScript, plus Python scripts that download the data.
It is a sister site of the Euroleague Hub and the ACB Hub and works the same way.

## Pages

| Page | What it shows |
|------|---------------|
| **Home** | Latest results, next games (with predicted scores), standings, stat leaders |
| **Standings** | Full table: games, wins, losses, points for/against, +/-, last 5 games, and the season forecast |
| **Stats** | Players: per-game averages, shooting percentages (2P%, 3P%, FT%), turnovers and +/−. Teams: points per 100 possessions scored and allowed, pace, eFG%, rebounds and more. Click a column to sort |
| **Teams** | All 10 teams. Click one to see coach, team statistics with league rank, squad with season averages, and all 36 games |
| **Player** | Click any player's name: season averages with league rank, shooting, and his game log |
| **Schedule** | Go week by week through the season, filter by team |
| **Game** | Played: quarter scores and full box score for both teams. Upcoming: prediction, earlier meetings, both squads |
| **Predictions** | Win probability and predicted score for the next two weeks, plus a "pick any two teams" tool |
| **Betting** | Next week's games simulated 40,000 times each; compare with bookmaker odds, find value bets, keep a bet log |
| **Ticket** | Suggested ticket for the next week with the reasons for each pick: value singles, a combo only when every leg has value, and the minimum odds each pick needs |

**Weeks, not rounds.** lkl.lt does not number rounds, and teams that also play in Europe move their games
around, so the site groups games by week (Monday to Sunday): "Week 5" is the fifth week of the season with
games in it.

## Run it

Open `index.html` in your browser (double-click it). If your browser blocks it, serve the folder:

```
python -m http.server 8002
```

and open http://localhost:8002.

## Updating the data

```
python update_data.py
```

This reads everything from lkl.lt and writes `js/data.js`: clubs, coaches, all games, and box scores of
every played game. Player season averages are calculated from those box scores. Run it after each week to
get new results.

- `lkl.py` reads lkl.lt: the schedule and results lists, the box scores (the site's own JSON) and the
  players' pages. If lkl.lt changes how it is built, `lkl.py` is the only file to fix.
- lkl.lt allows about 60 requests a minute. When it says "busy", the script waits and continues; the very
  first run downloads two past seasons (about 370 box scores) and takes several minutes, later runs a few
  seconds.
- Finished box scores are cached in `.cache/` so later runs only download new games.
- **Squads** are taken from the box scores: a team's squad is everyone listed for one of its last three
  games (lkl.lt's own squad lists can't be read by a script). A newly signed player appears after his first
  game; nationalities are not shown.
- It always shows the season lkl.lt is showing now. The King Mindaugas Cup (KMT) is not included.

Requires Python 3 (standard library only, nothing to install).

### Automatic daily update

On GitHub, the workflow in `.github/workflows/update-data.yml` keeps `js/data.js` current and the website
(GitHub Pages) redeploys by itself after every change:

- **After games:** every half hour from 15:00 to 22:00 UTC it runs `update_data.py --if-new`, which reads
  the results list to see whether a game has finished since the last update and only then does the full
  update.
- **Every morning** (05:23 UTC) it runs a full update, which also picks up schedule changes.

GitHub starts scheduled jobs late when it is busy (sometimes by hours), so results can take a while to
appear. To update right away: **Actions → Update LKL data → Run workflow**.

Live site: https://tomlebedev-cloud.github.io/lkl/

Note: GitHub pauses scheduled workflows in repositories with no activity for 60 days (e.g. in the
summer off-season). If that happens, re-enable it from the Actions tab.

## How predictions work

The model lives in `model.py` and runs inside `update_data.py`; the website only reads its output.
It is the Euroleague Hub model with every setting measured again on LKL seasons.

- **Attack and defence ratings.** Each team gets an attack rating (points scored vs. an average team) and a
  defence rating (points allowed), estimated from all games with a weighted ridge regression, so they are
  **adjusted for opponent strength**. Recent games count more (a game 240 days old counts half).
- **Preseason starting point.** Ratings begin at 85% of last season's level, adjusted for **summer
  transfers**: the last-season LKL PIR of players who arrived minus players who left, compared with the
  league's average change (1 point per 1000 PIR). A promoted team starts at the usual level of promoted
  teams, about 9.5 points per game below average. This starting point is worth about 18 games of evidence,
  so early-season predictions lean on it and this season's results gradually take over.
- **Game prediction.** Predicted score = league average + attack + opponent's defence, with +1.2 points for
  the home team (home teams win only 55% of LKL games). The margin becomes a win chance with a logistic
  curve.

### Accuracy (backtested)

`backtest.py` replays past seasons game by game, predicting each game using only earlier games
(playoffs included):

| 2023-24 → 2025-26 (562 games) | Winner right | Log loss | Brier | Margin error |
|---|---|---|---|---|
| Always pick the home team | 54.6% | | | |
| Simple model (season points per game) | 67.3% | 0.574 | 0.197 | 10.7 pts |
| **Current model** | **70.1%** | **0.524** | **0.180** | **9.9 pts** |

Lower log loss / Brier means better win probabilities. Rating settings were tuned on 2023-24 and 2024-25
and checked on 2025-26 (log loss 0.575 on that unseen season); the probability scale was fitted on all
three seasons. That is fewer games than for the other hubs (a season has about 180), so these numbers are
less certain. Run `python backtest.py` to reproduce, `python backtest.py --tune` to search settings,
`python backtest.py --promoted` to see how promoted teams did.

The site also shows the model's live track record for the current season week by week (next to
"home team won" and the bookmaker's favourite, with the most confident miss of each week), and on every
finished game what it predicted before tip-off.

### Betting page

For each game of the next week the page simulates 40,000 final scores: margin and total are drawn
around the model's prediction with the spread measured on past seasons (`python backtest.py --spread`,
stored in `model.SIM`: margin ±12.8, total ±16.6 points). Ties go to overtime. From the simulations it
shows fair odds, a fair handicap and total, and model chances at nearby lines.

Type in a bookmaker's decimal odds (winner, handicap, total). The page removes the bookmaker margin,
blends the model's chance with the bookmaker's ("model weight", default 25%, because the bookmaker knows
about injuries and news), and shows the expected value and a stake (¼ Kelly, at most 2% of the bankroll).
Odds, settings and the bet log are saved in your browser only, separately from the other hubs';
bet results settle automatically after the data update.

**Published odds.** `js/odds.js` holds bookmaker odds for the next games, typed in by hand from the
bookmaker's site (TopSport); they fill in every game you haven't entered your own odds for, and count in
the odds history. Update it before each week (the game code is the number at the end of the game's
address, e.g. `#game/11600`).

**Odds template.** "Copy template" gives a plain-text form with every game of the week
(`Win: home away`, `Hcp: line home away`, `Tot: line over under`); fill in the bookmaker's odds and paste it
back with "Apply" (or paste it into a chat).

**Odds history.** Every set of odds you type is saved with the model's chances at that moment (edits within
30 minutes replace the last save, later ones are added, so line moves are kept). Odds lock at tip-off. For
finished games the page compares the model's and the bookmaker's log loss per market, and the result of
1 € on every value bet. Everything stays in the browser; **Export / Import** moves it to another device
or keeps a backup.

**Line-ups.** Each team's three most productive regulars (PIR per game, early in the season leaning on
last season) are its key players. Every key player who doesn't play costs his team 1.5 points of margin.
Players no longer in the squad are counted out; everyone else you tick yourself from the injury news.
Measured with `python backtest.py --absences` on 2023-24 to 2025-26: teams missing a key player did
1.2–2.1 points worse per player in every season, but using that did not make the win chances better
(log loss 0.534 → 0.535), probably because the clubs that also play in Europe rest players in LKL games
they win anyway. Treat it as a small correction, not an edge.

**Pace.** Adding points to the predicted total for fast teams was tested (`python backtest.py --pace`) and
is switched off: the effect had a different sign in different seasons.

**Model weight 25% by default.** The LKL model was tuned on fewer games than the other hubs and has
never been tested against real bookmaker odds, so the Betting, Ticket and Plan pages count the bookmaker's
chance three times as much as the model's. Check the season's track record on the Predictions page (model
vs. the bookmaker's favourite) after a few more weeks before giving the model more weight.

The model has a real edge over a coin flip on winners and margins, but totals are weak (mean error 12.9
points), and no test against real bookmaker odds has been done. Treat "value" as a signal to look closer,
not a sure thing.

### Season forecast

The Standings page also shows each team's chance of finishing in the top 8 (playoffs) or last, and its
expected final wins. `update_data.py` plays out the rest of the regular season 10,000 times
(`model.simulate_season`): every game's margin is drawn around the model's prediction, and in each run
every team's strength is also shifted by a random 2.5 points, because the ratings are uncertain themselves.

`python backtest.py --season` forecasts the last three seasons before the first game and after weeks 4, 10
and 20 and compares with how they ended. Brier score for "finishes top 8": 0.081 (most teams make the top 8,
so this is an easy question in the LKL). Teams given 50–90% made it 78% of the time. Final wins were off by
3.1 on average before the season and 1.8 after week 20. Ties are ordered by point difference, not the
official head-to-head rule.

Standings follow the official LKL order (downloaded with the data), which applies the league's
tie-breakers such as head-to-head results. If the official table is behind the results shown, the site
falls back to wins, then point difference. Only regular-season games count; a game is treated as a playoff
game once the two teams have already met as often as the regular season has them meet.

## Project structure

```
index.html       page layout and navigation
css/style.css    styles (light + dark mode)
js/app.js        pages, standings and stats
js/betting.js    betting page: simulation, odds comparison, bet log
js/ticket.js     ticket page: suggested bets and the reasons for them
js/odds.js       bookmaker odds for the next games (edit by hand)
js/data.js       generated data — don't edit by hand
update_data.py   builds js/data.js
lkl.py           reads lkl.lt (clubs, games, box scores, players, standings)
model.py         prediction model
backtest.py      measures prediction accuracy on past seasons
```

Not affiliated with the LKL. Data and team logos belong to their owners.
