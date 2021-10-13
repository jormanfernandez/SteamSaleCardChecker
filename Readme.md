# How to use

Just run
```sh
npm install
```

And the run
```sh
npm start
```

This will generate the report for the actual datetime and save it as a log.
The script accepts various arguments to proceess data diferently
```json
{
  "generateReport": "Boolean field to indicate if we want the script to create a report file. Default true",
  "priceOrder": "ENUM(asc, desc) to order the results based on the price. Default desc",
  "iterations": "Amount of iterations to lookup in the Steam API. Depends on the amount of game on sales, a good value would be between 15 and 20 to get all the games on the steam sales page",
  "minPrice": "A number divisible by 7. This was made with ARS store in mind... so, sorry not sorry",
  "resultsPerPage": "Amount of results that each iteration will count. The max amount can be 100",
}
```

To pass those arguments to the script, you should run
```sh
npm start -- --priceOrder=desc --iterations=5 --generateReport=true
```