const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

// Store latest scan result
let latestScanResult = null;
let wss = null;

// Create HTTP server for serving the webpage
const server = http.createServer((req, res) => {
    if (req.url === '/' || req.url === '/shortindex.html') {
        fs.readFile(path.join(__dirname, 'shortindex.html'), (err, data) => {
            if (err) {
                res.writeHead(404);
                res.end('File not found');
                return;
            }
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(data);
        });
    } else if (req.url === '/api/pairs') {
        // API endpoint to fetch pairs with funding rates
        fetchPairsWithFundingRates()
            .then(data => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(data));
            })
            .catch(error => {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: error.message }));
            });
    } else {
        res.writeHead(404);
        res.end('Not found');
    }
});

// Create WebSocket server
wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
    console.log('Client connected to WebSocket');

    // Send latest scan result to new client if available
    if (latestScanResult) {
        ws.send(JSON.stringify({
            type: 'latestData',
            data: latestScanResult
        }));
    }

    ws.on('close', () => {
        console.log('Client disconnected from WebSocket');
    });
});

// Function to broadcast scan results to all connected clients
function broadcastScanResult(scanResult) {
    latestScanResult = scanResult;
    if (wss) {
        wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({
                    type: 'newScan',
                    data: scanResult
                }));
            }
        });
    }
}


// Function to fetch funding rates for all symbols
async function fetchFundingRates() {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'fapi.binance.com',
            path: '/fapi/v1/premiumIndex',
            method: 'GET',
            headers: {
                'User-Agent': 'Node.js'
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => {
                data += chunk;
            });
            res.on('end', () => {
                try {
                    const fundingData = JSON.parse(data);
                    resolve(fundingData);
                } catch (error) {
                    reject(error);
                }
            });
        });

        req.on('error', (error) => {
            reject(error);
        });

        req.end();
    });
}

// Function to fetch kline data for a symbol
async function fetchKlineData(symbol, interval = '1m', limit = 100) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'fapi.binance.com',
            path: `/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`,
            method: 'GET',
            headers: {
                'User-Agent': 'Node.js'
            }
        };

        const req = https.request(options, (res) => {
            let data = '';

            res.on('data', (chunk) => {
                data += chunk;
            });

            res.on('end', () => {
                if (res.statusCode !== 200) {
                    console.error(`${symbol} - HTTP ${res.statusCode}`);
                    reject(new Error(`HTTP ${res.statusCode}: ${data}`));
                    return;
                }

                try {
                    const klines = JSON.parse(data);
                    resolve(klines);
                } catch (error) {
                    console.error(`JSON parse error for ${symbol}:`, error.message);
                    reject(error);
                }
            });
        });

        req.on('error', (error) => {
            reject(error);
        });

        req.end();
    });
}

// Function to calculate Standard Deviation
function calculateStandardDeviation(prices, period, mean) {
    const squaredDifferences = prices.map(price => Math.pow(price - mean, 2));
    const variance = squaredDifferences.reduce((a, b) => a + b, 0) / period;
    return Math.sqrt(variance);
}

// Function to calculate Bollinger Bands
function calculateBollingerBands(closePrices, period = 20, multiplier = 2) {
    if (closePrices.length < period) {
        return null;
    }

    const bollingerBands = [];

    for (let i = period - 1; i < closePrices.length; i++) {
        const subset = closePrices.slice(i - period + 1, i + 1);
        const sma = subset.reduce((a, b) => a + b, 0) / period;
        const stdDev = calculateStandardDeviation(subset, period, sma);
        const upperBand = sma + (multiplier * stdDev);
        const lowerBand = sma - (multiplier * stdDev);

        bollingerBands.push({
            timestamp: i,
            sma: sma,
            upperBand: upperBand,
            lowerBand: lowerBand,
            price: closePrices[i]
        });
    }

    return bollingerBands;
}

// Function to fetch pairs with funding rates and Bollinger Bands
async function fetchPairsWithFundingRates() {
    try {
        console.log('Fetching funding rates from Binance Futures...');
        const fundingData = await fetchFundingRates();

        // Filter only USDT pairs with positive funding rate > 0.00005000
        const usdtPairs = fundingData
            .filter(item => item.symbol.endsWith('USDT'))
            .map(item => ({
                symbol: item.symbol,
                fundingRate: parseFloat(item.lastFundingRate || 0)
            }))
            .filter(item => item.fundingRate > 0.00005000)
            .sort((a, b) => b.fundingRate - a.fundingRate);

        console.log(`Found ${usdtPairs.length} USDT pairs with funding rate > 0.00005000`);
        console.log('Fetching 1-minute kline data and calculating Bollinger Bands...');

        // Process pairs in batches to respect rate limits (40 req/sec)
        const batchSize = 39;
        const enrichedPairs = [];

        for (let i = 0; i < usdtPairs.length; i += batchSize) {
            const batch = usdtPairs.slice(i, i + batchSize);
            console.log(`Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(usdtPairs.length / batchSize)} (${batch.length} pairs)...`);

            const batchPromises = batch.map(async (pair) => {
                try {
                    // Fetch both 1-minute and 1-day klines
                    const [klines1m, klines1d] = await Promise.all([
                        fetchKlineData(pair.symbol, '1m', 100),
                        fetchKlineData(pair.symbol, '1d', 100)
                    ]);

                    if (!Array.isArray(klines1m) || klines1m.length < 20) {
                        return {
                            ...pair,
                            error: 'Insufficient 1m data'
                        };
                    }

                    if (!Array.isArray(klines1d) || klines1d.length < 20) {
                        return {
                            ...pair,
                            error: 'Insufficient 1d data'
                        };
                    }

                    // Process 1-minute data
                    const closePrices1m = klines1m.map(kline => parseFloat(kline[4]));
                    const currentPrice = closePrices1m[closePrices1m.length - 1];
                    const bollingerBands1m = calculateBollingerBands(closePrices1m, 20, 2);

                    // Process 1-day data
                    const closePrices1d = klines1d.map(kline => parseFloat(kline[4]));
                    const bollingerBands1d = calculateBollingerBands(closePrices1d, 20, 2);

                    if (bollingerBands1m && bollingerBands1m.length > 0 && bollingerBands1d && bollingerBands1d.length > 0) {
                        const latest1m = bollingerBands1m[bollingerBands1m.length - 1];
                        const percentAboveMiddle = ((currentPrice - latest1m.sma) / latest1m.sma) * 100;
                        const bandPosition = ((currentPrice - latest1m.lowerBand) / (latest1m.upperBand - latest1m.lowerBand)) * 100;

                        // Prepare 1-minute chart data (last 50 candles)
                        const chartData1m = klines1m.slice(-50).map((kline) => ({
                            time: kline[0],
                            open: parseFloat(kline[1]),
                            high: parseFloat(kline[2]),
                            low: parseFloat(kline[3]),
                            close: parseFloat(kline[4])
                        }));

                        // Prepare 1-day chart data (last 50 candles)
                        const chartData1d = klines1d.slice(-50).map((kline) => ({
                            time: kline[0],
                            open: parseFloat(kline[1]),
                            high: parseFloat(kline[2]),
                            low: parseFloat(kline[3]),
                            close: parseFloat(kline[4])
                        }));

                        const bbChartData1m = bollingerBands1m.slice(-50);
                        const bbChartData1d = bollingerBands1d.slice(-50);

                        // Get 24h volume in USDT from the latest 1-day candle (index 7 is quote asset volume)
                        const volume24h = parseFloat(klines1d[klines1d.length - 1][7]);
                        const volumeInMillions = volume24h / 1000000;

                        return {
                            ...pair,
                            currentPrice,
                            sma: latest1m.sma,
                            upperBand: latest1m.upperBand,
                            lowerBand: latest1m.lowerBand,
                            percentAboveMiddle,
                            bandPosition,
                            volume24h: volumeInMillions,
                            candles1m: chartData1m,
                            bollingerBands1m: bbChartData1m,
                            candles1d: chartData1d,
                            bollingerBands1d: bbChartData1d
                        };
                    }

                    return {
                        ...pair,
                        error: 'BB calculation failed'
                    };

                } catch (error) {
                    console.error(`Error processing ${pair.symbol}:`, error.message);
                    return {
                        ...pair,
                        error: error.message
                    };
                }
            });

            const batchResults = await Promise.all(batchPromises);
            enrichedPairs.push(...batchResults);

            // Wait 1 second between batches (except for last batch)
            if (i + batchSize < usdtPairs.length) {
                console.log('Waiting 1 second before next batch...');
                await new Promise(resolve => setTimeout(resolve, 1100));
            }
        }

        const successfulPairs = enrichedPairs.filter(p => !p.error);

        // Filter to only show pairs where price is above SMA
        const pairsAboveSMA = successfulPairs.filter(p => p.percentAboveMiddle > 0);

        // Sort by percentAboveMiddle from highest to lowest
        pairsAboveSMA.sort((a, b) => b.percentAboveMiddle - a.percentAboveMiddle);

        console.log(`Successfully processed ${successfulPairs.length}/${usdtPairs.length} pairs`);
        console.log(`Pairs above SMA: ${pairsAboveSMA.length}/${successfulPairs.length}`);

        return pairsAboveSMA;
    } catch (error) {
        console.error('Error fetching pairs:', error.message);
        throw error;
    }
}

// Function to run scan and broadcast results
async function runScanAndBroadcast() {
    const runTime = new Date();
    console.log(`\n${'='.repeat(60)}`);
    console.log(`🚀 STARTING SCAN AT ${runTime.toLocaleTimeString()}`);
    console.log(`${'='.repeat(60)}`);

    try {
        const pairs = await fetchPairsWithFundingRates();

        const scanResult = {
            timestamp: new Date().toISOString(),
            scanTime: new Date().toLocaleTimeString(),
            totalPairs: pairs.length,
            pairs: pairs
        };

        // Broadcast to all connected WebSocket clients
        broadcastScanResult(scanResult);

        const used = process.memoryUsage().heapUsed / 1024 / 1024;
        console.log(`\n${'='.repeat(60)}`);
        console.log(`✅ SCAN COMPLETED AT ${new Date().toLocaleTimeString()}`);
        console.log(`Found ${pairs.length} pairs above SMA`);
        console.log(`Memory usage: ${Math.round(used * 100) / 100} MB`);
        console.log(`${'='.repeat(60)}\n`);
    } catch (error) {
        console.error('Error during scan:', error);
    }
}

// Function to schedule scans at 3 seconds after every minute
function scheduleMinutelyScans() {
    console.log('Starting automatic scanner - runs at 3 seconds after every minute');
    console.log('Checking time every second...\n');

    let lastRunMinute = -1;

    // Check every second
    setInterval(() => {
        const now = new Date();
        const currentMinute = now.getMinutes();
        const currentSecond = now.getSeconds();

        // Run at 3 seconds past the minute, and only once per minute
        if (currentSecond === 3 && currentMinute !== lastRunMinute) {
            lastRunMinute = currentMinute;
            runScanAndBroadcast();
        }

        // Show countdown every 5 seconds (optional, for monitoring)
        if (currentSecond % 5 === 0 && currentSecond !== 3) {
            const secondsUntilNext = currentSecond < 3 ? (3 - currentSecond) : (63 - currentSecond);
            console.log(`Next scan in ${secondsUntilNext} seconds... (${now.toLocaleTimeString()})`);
        }
    }, 1000); // Check every 1 second
}

// Start the HTTP server
const PORT = 3001;
server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log('WebSocket server ready for connections');
    console.log('Open your browser and navigate to the URL above\n');

    // Start the automatic scanning
    scheduleMinutelyScans();
});
