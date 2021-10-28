const fs = require('fs')
const axios = require("axios");

const { JSDOM } = require("jsdom");

/**
 * Parse command arguments
 */
const argv = require("minimist")(process.argv.slice(2), {
  boolean: ['generateReport', 'omitOwnedGames'],
  string: ['priceOrder', 'steamId', 'country', 'tags'],
  default: {
    country: 'ar',
    steamId: '-num',
    tags: '',
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

const Tag = {};


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

  const parsedString = str.replace(/\n/g, '').replace(/\t/g, '').replace(/\r/g, '');

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

/**
 * Main function to search the games and generate the report
 */
const run = async () => {

  log("Getting the steam tags");
  const steamSearchUrl = "https://store.steampowered.com/search/";
  const { window: { document: searchDom } } = new JSDOM((await axios.get(steamSearchUrl)).data);
  const filterNode = searchDom.querySelector("#TagFilter_Container");
  const tagNodes = filterNode.querySelectorAll(".tab_filter_control_row");
  tagNodes.forEach(node => Tag[node.dataset.loc.toLowerCase()] = node.dataset.value);

  log(`Found ${Object.keys(Tag).length} tags`);

  let steamStartIndex = 0;
  let iterationCounter = 1;

  const steamSearchPages = [];

  log("Starting to checkout sales page...");

  let filterTags = [];

  if (argv.tags) {
    /**
     * If the tags argument has any values, it will filter by those.
     * The arguments should be passed as a string and if the user wants to
     * search by multiple tags, send them separated by commas like
     * --tags="Anime,FPS"
     */
    let tags = argv.tags.split(",");
    tags.forEach(tag => {
      if (!(tag.toLowerCase() in Tag)) {
        return;
      }

      filterTags.push(tag.toLowerCase());
    });
  }

  if (filterTags.length > 0) {
    log(`Limiting search by: ${filterTags.join(", ")}`);
    filterTags = filterTags.map(tag => Tag[tag]).join(",");
  } else {
    filterTags = null;
  }

  while (iterationCounter < argv.iterations) {
    let steamUrl = "https://store.steampowered.com/search/results/";
    steamSearchPages.push((await axios.get(steamUrl, {
      params: {
        query: '',
        start: steamStartIndex,
        count: argv.resultsPerPage,
        maxprice: argv.minPrice,
        specials: 1,
        infinite: 1,
        cc: argv.country,
        tags: filterTags
      }
    })));

    iterationCounter++;
    steamStartIndex = iterationCounter * argv.resultsPerPage;
  }

  const responses = steamSearchPages.filter(response => response.data.success == 1).map(response => response.data);
  let apps = {};
  let ownedApps = [];

  if (argv.omitOwnedGames && argv.steamId) {
    log(`Getting all owned games for Steam Id: ${argv.steamId}`);

    const steamUrl = `https://steamcommunity.com/id/${argv.steamId}/games/`;

    /**
     * Regex to extract the game variable from the profile html 
     */
    const regexOwnedGames = /var rgGames...\[.*\]/gmi;
    const response = (await axios.get(steamUrl, {
      params: {
        tab: "all"
      }
    })).data;

    const ownedGames = JSON.parse(response.match(regexOwnedGames)[0].replace(/var rgGames.../g, ''));
    ownedApps = [
      ...ownedGames.map(game => game.appid.toString())
    ];

    log(`Steam Id: ${argv.steamId} has ${ownedApps.length} games. Those games will be skipped in the report`);
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
  const steamCardGuestAPI = "https://www.steamcardexchange.net/api/request.php";
  const allGamesWithCards = (await axios.get(steamCardGuestAPI, {
    params: {
      GetBadgePrices_Guest: ''
    }
  })).data.data ?? [];

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
    exchange: `https://www.steamcardexchange.net/index.php?gamepage-appid-${game[0][0]}`,
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

  log(`${gamesWithCards.length} games have Steam Cards.`);

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
      if (!err) {
        log("Report generated successfully. Thanks!");
      } else {
        log(`Couldn't write file: ${err}`);
      }
    }
  );
}

run();
