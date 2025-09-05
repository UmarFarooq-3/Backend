const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');
const { chromium } = require('playwright');
const keys = require('./credentials.json');

const app = express();
app.use(cors());
app.use(cors({ origin: "*" }));
app.use(express.json());

const SHEET_ID = '1ctXkgyeG8xm2E8FXpaRO3FlpGo2vRopZ2Xm0cxtrAkM';

const auth = new google.auth.GoogleAuth({
  credentials: keys,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

let browser;
let page;
let scraping = false;
let asinQueue = [];
let prices = {}; // In-memory price store

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function initBrowser() {
  if (!browser) {
    browser = await chromium.launch({
      headless: false,
      channel: 'chrome',
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const context = await browser.newContext();
    page = await context.newPage();
    await page.goto('https://www.amazon.com', { waitUntil: 'networkidle' });
    await delay(5000);
  }
}

async function scrapePrice(asin) {
  const url = `https://www.amazon.com/dp/${asin}`;
  let price = 'Price not found';
  try {
    await initBrowser();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(5000);

    const selectors = ['span.a-price .a-offscreen', '#priceblock_ourprice', '#priceblock_dealprice'];
    for (const selector of selectors) {
      const element = await page.$(selector);
      if (element) {
        const priceText = await element.textContent();
        if (priceText.includes('$')) {
          price = priceText.trim();
          break;
        }
      }
    }
  } catch (err) {
    price = 'Error: ' + err.message;
  }
  prices[asin] = price;
  return price;
}

async function startScraping() {
  scraping = true;
  while (scraping) {
    if (asinQueue.length === 0) {
      await delay(5000);
      continue;
    }
    const asin = asinQueue.shift();
    await scrapePrice(asin);
    await delay(10000);
  }
}

const PORT = process.env.PORT || 5000;

app.post('/start', async (req, res) => {
  if (scraping) return res.json({ status: true, message: 'Already running' });

  const authClient = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: authClient });
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const sheetName = meta.data.sheets[0].properties.title;
  const sheetData = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${sheetName}!B:B`,
  });

  asinQueue = (sheetData.data.values || [])
    .map(row => row?.[0]?.match(/([A-Z0-9]{10})/)?.[1])
    .filter(Boolean);

  startScraping();
  res.json({ status: true, message: 'Scraping started', queue: asinQueue });
});

app.post('/stop', (req, res) => {
  scraping = false;
  res.json({ status: true, message: 'Scraping stopped' });
});

app.get('/state', (req, res) => {
  res.json({
    status: true,
    isRunning: scraping,
    items: prices
  });
});


app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
