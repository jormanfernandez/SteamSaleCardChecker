const fs = require('fs')
const axios = require("axios");

const { JSDOM } = require("jsdom");

/**
 * Parse command arguments
 */
const argv = require("minimist")(process.argv.slice(2), {
  boolean: ['isGenerateReport', 'isOmitOwnedGames', 'isOnlyCards', 'isOnlyPositiveReviews'],
  string: ['priceOrder', 'steamId', 'country', 'tags', 'minDiscount'],
  default: {
    country: 'ar',
    steamId: '-num',
    tags: '',
    isOmitOwnedGames: true,
    isGenerateReport: true,
    isOnlyCards: true,
    minDiscount: null,
    isOnlyPositiveReviews: false,
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

  const matches = [...new Set(parsedString.match(re) || [])];
  const apps = {};

  for (let match of matches) {

    const appId = match.split("app/")[1];

    if (argv.isOmitOwnedGames && ownedApps.indexOf(appId) > -1) {
      continue;
    }

    /**
     * Regex to extract the block of html code for a single app
     */
    const gameRe = new RegExp(`<a href="https://store.steampowered.com/app/${appId}.*?<\/a>`, 'gi');
    const block = (parsedString.match(gameRe) ?? [])[0] ?? '';
    if (!block) {
      continue;
    }

    const { window: { document: anchor } } = new JSDOM(block);
    const name = anchor.querySelector('span.title').innerHTML;
    if (!name) {
      continue;
    }

    if (argv.isOnlyPositiveReviews && !anchor.querySelector('div.search_reviewscore > .positive')) {
      continue;
    }

    const discountPercent = Math.abs(parseFloat(anchor.querySelector('.search_discount > span').innerHTML));

    if (argv.minDiscount != null && (argv.minDiscount > discountPercent || discountPercent == null || isNaN(discountPercent))) {
      continue;
    }

    const price = parseFloat(anchor.querySelector('.search_price_discount_combined').getAttribute('data-price-final'));

    apps[appId] = {
      id: appId,
      name,
      discountPercent,
      price
    }
    if (!apps[appId].price || apps[appId].price <= 0) {
      delete apps[appId];
      continue;
    }
  }

  return apps;
}

/**
 * Handles all the responses from the steam search pages
 * @param {Array} promises 
 */
const handlePromises = async promises => {
  const responses = promises.filter(response => response.data.success == 1).map(response => response.data);
  let apps = {};
  let ownedApps = [];

  if (argv.isOmitOwnedGames && argv.steamId) {
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
    ownedApps = ownedGames.map(game => game.appid.toString());

    log(`Steam Id: ${argv.steamId} has ${ownedApps.length} games. Those games will be skipped in the report`);
  }

  if (argv.minDiscount) {
    log(`Skipping games with a discount lower than ${argv.minDiscount}%`);
  }

  if (argv.isOnlyPositiveReviews) {
    log('Looking only positive reviews')
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

  let foundGames = [];

  if (argv.isOnlyCards) {
    log("Looking which of them have steam cards...");
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
    foundGames = allGamesWithCards.filter(game => game[0][0] in apps).map(game => ({
      ...apps[game[0][0]],
      link: `https://store.steampowered.com/app/${game[0][0]}`,
      market: `https://steamcommunity.com/market/search?appid=${game[0][0]}`,
      exchange: `https://www.steamcardexchange.net/index.php?gamepage-appid-${game[0][0]}`,
      badgePrice: game[2]
    }));

    /**
     * Sorts the game
     */
    foundGames.sort((a, b) => argv.priceOrder == 'desc' ? b.price - a.price : a.price - b.price);
    foundGames = foundGames.map(game => {
      let price = game.price.toString();
      let decimals = price.substr(-2);
      price = `${price.substr(0, price.length - 2)}.${decimals}`;

      return {
        ...game,
        price
      }
    });

    log(`${foundGames.length} games have Steam Cards.`);

  } else {
    /**
     * Searches in steam card exchange to see if the game has any registered card
     * and then maps the response to have an id, price and a direct link
     */
    foundGames = Object.values(apps).filter(game => game.id in apps).map(game => ({
      ...game,
      link: `https://store.steampowered.com/app/${game.id}`,
      market: `https://steamcommunity.com/market/search?appid=${game.id}`,
      exchange: `https://www.steamcardexchange.net/index.php?gamepage-appid-${game.id}`,
    }));

    /**
     * Sorts the game
     */
    foundGames.sort((a, b) => argv.priceOrder == 'desc' ? b.price - a.price : a.price - b.price);
    foundGames = foundGames.map(game => {
      let price = game.price.toString();
      let decimals = price.substr(-2);
      price = `${price.substr(0, price.length - 2)}.${decimals}`;

      return {
        ...game,
        price
      }
    });
  }
  
  if (!argv.isGenerateReport || foundGames.length < 1) return;

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
    JSON.stringify(foundGames, null, 2), err => {
      if (!err) {
        log("Report generated successfully. Thanks!");
      } else {
        log(`Couldn't write file: ${err}`);
      }
    }
  );
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

  const steamSearchPromises = [];

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
    steamSearchPromises.push(axios.get(steamUrl, {
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
    }));

    iterationCounter++;
    steamStartIndex = iterationCounter * argv.resultsPerPage;
  }

  Promise.all(steamSearchPromises).then(handlePromises);
}

run();
