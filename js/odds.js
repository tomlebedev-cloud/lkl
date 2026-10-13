// Bookmaker odds published with the site (winner, overtime included), used when you
// haven't typed your own for a game on the Betting page. Update by hand before each week of games:
// game code -> { ml: [home, away], hcp: [home line, home, away], tot: [line, over, under] }
// The game code is the number at the end of the game's address on the site (#game/11600).
const BOOK_ODDS = {
  source: "TopSport",
  taken: "2026-10-13",
  games: {
    // week 5 (taken 2026-10-13)
    11600: { ml: [2.75, 1.40] },  // Šiauliai – Rytas
    11601: { ml: [3.00, 1.33] },  // Jonava – Neptūnas
    11605: { ml: [3.00, 1.33] },  // Nevėžis – Lietkabelis
    11606: { ml: [1.55, 2.30] },  // Juventus – Gargždai
    11602: { ml: [1.01, 10.00] }, // Žalgiris – Tauragė
    // later
    11614: { ml: [4.00, 1.22] },  // week 8: Rytas – Žalgiris
  },
};
