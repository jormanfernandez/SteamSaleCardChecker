const fs = require('fs')
const axios = require("axios");

/**
 * Parse command arguments
 */
const argv = require("minimist")(process.argv.slice(2), {
  boolean: ['generateReport', 'omitOwnedGames'],
  string: ['priceOrder', 'steamId'],
  default: {
    steamId: '-num',
    omitOwnedGames: true,
    generateReport: true,
    priceOrder: 'asc',
    iterations: 30,
    minPrice: 70,
    resultsPerPage: 100,
  },
  unknown: parameter => {
    const value = parameter.split("--")[1].split("=")[1];
    return !isNaN(value);
  }
});

/**
 * 
 * @param {String} text Logs on the terminal a string with the datetime 
 */
const log = text => {
  const date = new Date();
  const time = `${[
    date.getHours(),
    date.getMinutes(),
    date.getSeconds(),
  ].join(":")} ${[
    date.getDate(),
    date.getMonth(),
    date.getFullYear(),
  ].join("-")}`
  console.log(`${time} - ${text}`);
}

/**
 * Reads from the str returned by steam api to detect the different apps in the whole html response (For some reason the return the results in plain html)
 * @param {String} str  
 * @returns {Object}
 */
const getApps = (str, ownedApps) => {

  const parsedString = str.replace(/\n/g, '').replace(/\t/g, '').replace(/\r/g, '')

  /**
   * Regex used to extract all the app ids from the steam response
   */
  const re = /\/app\/\d{1,10}/g;

  /** 
   * Regex to extract the price tag from the component
   */
  const priceRe = /data-price-final=\"\d{0,30}\"/g;

  const matches = [...new Set(parsedString.match(re) || [])];
  const apps = {};

  for (let match of matches) {

    const appId = match.split("app/")[1];

    if (argv.omitOwnedGames && ownedApps.indexOf(appId) > -1) {
      continue;
    }

    /**
     * Regex to extract the block of html code for a single app
     */
    const gameRe = new RegExp(`<a href="https://store.steampowered.com/app/${appId}.*?<\/a>`, 'gi');
    const block = (parsedString.match(gameRe) ?? [])[0] ?? '';
    const priceBlock = (block.match(priceRe) ?? [])[0];

    /**
     * Gets the price block and then parse it to a string.
     * Steam returns the final price as a full integer with the latest two digits being the decimals 
     */
    apps[appId] = (priceBlock ?? '').replace(/\D/g, '') ?? 0;
    apps[appId] = parseInt(apps[appId]);

    if (!apps[appId] || apps[appId] <= 0) {
      delete apps[appId];
      continue;
    }
  }

  return apps;
}

let steamStartIndex = 0;
let iterationCounter = 1;

const steamPromises = [];

log("Starting to checkout sales page...");

while (iterationCounter < argv.iterations) {
  let steamUrl = `https://store.steampowered.com/search/results/?query&start=${steamStartIndex}&count=${argv.resultsPerPage}&maxprice=${argv.minPrice}&specials=1&infinite=1`;
  steamPromises.push(axios.get(steamUrl));

  iterationCounter++;
  steamStartIndex = iterationCounter * argv.resultsPerPage;
}

/**
 * With all the promises parsed, load the responses and start checking which apps contains steam cards
 */
Promise.all(steamPromises).then(async promiseResponses => {
  const responses = promiseResponses.filter(response => response.data.success == 1).map(response => response.data);
  let apps = {};
  let ownedApps = [];

  if (argv.omitOwnedGames) {
    log(`Getting all owned games for Steam Id: ${argv.steamId}`);

    const steamUrl = `https://steamcommunity.com/id/${argv.steamId}/games/?tab=all`;
    const regexOwnedGames = /var rgGames...\[.*\]/gmi;
    const response = (await axios.get(steamUrl)).data;

    const ownedGames = JSON.parse(response.match(regexOwnedGames)[0].replace(/var rgGames.../g, ''));
    ownedApps = [
      ...ownedGames.map(game => game.appid.toString())
    ];

    log(`Steam Id: ${argv.steamId} has ${ownedApps.length} games. Those games will be skipeed in the report`);
  }

  for (let r of responses) {
    const foundApps = getApps(r.results_html, ownedApps);
    apps = {
      ...apps,
      ...foundApps
    }
  }

  log(`Found ${Object.keys(apps).length} games on sale.`);

  if (Object.keys(apps).length < 1) return;

  log("Looking which of them have steam cards...")
  const steamCardGuestAPI = "https://www.steamcardexchange.net/api/request.php?GetBadgePrices_Guest";
  const allGamesWithCards = (await axios.get(steamCardGuestAPI)).data.data ?? [];

  /**
   * Searches in steam card exchange to see if the game has any registered card
   * and then maps the response to have an id, price and a direct link
   */
  let gamesWithCards = allGamesWithCards.filter(game => game[0][0] in apps).map(game => ({
    id: game[0][0],
    name: game[0][1],
    price: apps[game[0][0]],
    link: `https://store.steampowered.com/app/${game[0][0]}`,
    market: `https://steamcommunity.com/market/search?appid=${game[0][0]}`,
    badgePrice: game[2]
  }));

  /**
   * Sorts the game
   */
  gamesWithCards.sort((a, b) => argv.priceOrder == 'desc' ? b.price - a.price : a.price - b.price);
  gamesWithCards = gamesWithCards.map(game => {
    let price = game.price.toString();
    let decimals = price.substr(-2);
    price = `${price.substr(0, price.length - 2)}.${decimals}`;

    return {
      ...game,
      price
    }
  });

  log(`${gamesWithCards.length} games have Steam Cards.`)

  if (!argv.generateReport || gamesWithCards.length < 1) return;

  log("Generating report...");

  const date = new Date();
  const fileName = `report-${[
    date.getHours(),
    date.getMinutes(),
    date.getSeconds(),
    date.getDate(),
    date.getMonth(),
    date.getFullYear(),
  ].join('-')}.json`;

  fs.writeFile(
    fileName,
    JSON.stringify(gamesWithCards, null, 2), err => {
      if (!err) return;
      console.error(`Couldn't write file: ${err}`);
    }
  );

  log("Report generated successfully. Thanks!");
});