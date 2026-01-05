// server.js - Historical Feed Backend
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const axiosRetry = require('axios-retry');

const app = express();

/**
 * =========================
 * Wikipedia topic presets
 * =========================
 */
const WIKI_TOPICS = {
  "american-literature": [
    'deepcat:"American literature"',
    'deepcat:"American novelists"',
    'deepcat:"American poets"',
    'deepcat:"American short story writers"'
  ],

  "italian-renaissance": [
    'deepcat:"Italian Renaissance"',
    'deepcat:"Renaissance in Italy"',
    'deepcat:"Italian Renaissance painters"',
    'deepcat:"Italian Renaissance architecture"'
  ],

  // NEW TOPICS
  "italian-history": [
    'deepcat:"History of Italy"',
    'deepcat:"Italian unification"',
    'deepcat:"Kingdom of Italy"',
    'deepcat:"Italian Republic"'
  ],

  "us-history": [
    'deepcat:"History of the United States"',
    'deepcat:"American Revolution"',
    'deepcat:"American Civil War"',
    'deepcat:"United States history by period"'
  ],

  "modern-german-literature": [
    'deepcat:"German literature"',
    'deepcat:"20th-century German literature"',
    'deepcat:"21st-century German literature"',
    'deepcat:"German novelists"'
  ],

  "modern-austrian-literature": [
    'deepcat:"Austrian literature"',
    'deepcat:"20th-century Austrian literature"',
    'deepcat:"21st-century Austrian literature"'
  ],

  "modern-swiss-literature": [
    'deepcat:"Swiss literature"',
    'deepcat:"Swiss novelists"',
    'deepcat:"Swiss writers"',
    'deepcat:"20th-century Swiss literature"'
  ],

  "italian-literature": [
    'deepcat:"Italian literature"',
    'deepcat:"Italian novelists"',
    'deepcat:"Italian poets"',
    'deepcat:"20th-century Italian literature"'
  ],
};

const WIKI_CATEGORY_TOPICS = {
  "american-literature": [
    "Category:American literature",
    "Category:American novelists",
    "Category:American poets",
    "Category:American short story writers"
  ],
  "italian-renaissance": [
    "Category:Italian Renaissance",
    "Category:Italian Renaissance painters",
    "Category:Italian Renaissance architecture"
  ],

  // NEW TOPICS
  "italian-history": [
    "Category:History of Italy",
    "Category:Italian unification",
    "Category:Italian states"
  ],

  "us-history": [
    "Category:History of the United States",
    "Category:United States history by period",
    "Category:Political history of the United States"
  ],

  "modern-german-literature": [
    "Category:German literature",
    "Category:20th-century German literature",
    "Category:21st-century German literature"
  ],

  "modern-austrian-literature": [
    "Category:Austrian literature",
    "Category:20th-century Austrian literature",
    "Category:21st-century Austrian literature"
  ],

  "modern-swiss-literature": [
    "Category:Swiss literature",
    "Category:Swiss writers",
    "Category:Swiss novelists"
  ],

  "italian-literature": [
    "Category:Italian literature",
    "Category:Italian novelists",
    "Category:Italian poets"
  ]
};

/**
 * =========================
 * Crash logging
 * =========================
 */
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err);
});
process.on('unhandledRejection', (reason, p) => {
  console.error('[FATAL] Unhandled Rejection at:', p, 'reason:', reason);
});

const PORT = process.env.PORT || 3000;

/**
 * =========================
 * Axios retry/backoff
 * =========================
 */
axiosRetry(axios, {
  retries: 3,
  retryDelay: (retryCount, error) => {
    const retryAfter = Number(error?.response?.headers?.['retry-after']);
    if (!Number.isNaN(retryAfter)) return retryAfter * 1000;
    return Math.min(1000 * 2 ** (retryCount - 1), 8000); // 1s,2s,4s, cap 8s
  },
  retryCondition: (error) => {
    if (error.code === 'ECONNABORTED') return true;
    const s = error?.response?.status;
    return s === 429 || s === 503 || s === 502 || s === 504;
  },
});

/**
 * =========================
 * Middleware
 * =========================
 */
app.use(cors()); // consider: cors({ origin: ['https://charges.github.io', 'http://localhost:8080'] })
app.use(express.json());

/**
 * =========================
 * In-memory cache
 * =========================
 */
let articleCache = [];
let lastRefresh = 0;
const CACHE_DURATION = 3600000; // 1 hour

/**
 * =========================
 * Tiny concurrency limiter
 * =========================
 */
async function mapWithLimit(items, limit, mapper) {
  const results = [];
  let i = 0;
  const workers = Array.from({ length: Math.max(1, limit) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try {
        results[idx] = await mapper(items[idx], idx);
      } catch (e) {
        results[idx] = null;
      }
    }
  });
  await Promise.all(workers);
  return results.filter(Boolean);
}

/**
 * =========================
 * Shakespeare (MIT) sonnets
 * =========================
 */
const SONNETS_INDEX_URL = 'https://shakespeare.mit.edu/Poetry/sonnets.html';
const SONNETS_BASE_URL  = 'https://shakespeare.mit.edu/Poetry/';

function normalizeSonnetText(s) {
  return (s || '')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

function extractRomanFromHref(href) {
  const m = String(href || '').match(/^sonnet\.([IVXLCDM]+)\.html$/i);
  return m ? m[1].toUpperCase() : null;
}

/**
 * =========================
 * Wikipedia fetchers
 * =========================
 */
function categorizeArticle(title, text) {
  const content = (title + ' ' + text).toLowerCase();
  if (content.match(/ancient|egypt|greek|roman|mesopotamia|bc|bce/)) return 'ancient';
  if (content.match(/medieval|middle ages|feudal|crusade|viking/)) return 'medieval';
  if (content.match(/renaissance|reformation|enlightenment|1400|1500|1600|1700/)) return 'early-modern';
  if (content.match(/industrial|revolution|1800|1900|20th century|war|modern/)) return 'modern';
  if (content.match(/technology|invention|computer|press|printing/)) return 'technology';
  return 'ancient';
}

async function fetchWikipediaArticles(count = 6, concurrency = 4) {
  const requests = Array.from({ length: count }, () => ({
    url: 'https://en.wikipedia.org/api/rest_v1/page/random/summary'
  }));

  const responses = await mapWithLimit(requests, concurrency, async (r) => {
    const resp = await axios.get(r.url, {
      timeout: 5000,
      headers: { 'User-Agent': 'HumanitiesFeed/1.0 (contact: you@example.com)' }
    });
    const d = resp.data;
    if (!d?.extract) return null;
    return {
      id: `wiki-${d.pageid || encodeURIComponent(d.title)}`,
      title: d.title,
      extract: d.extract,
      thumbnail: d.thumbnail?.source || d.originalimage?.source || null,
      url: d.content_urls?.desktop?.page,
      type: d.description || 'Article',
      readTime: Math.max(1, Math.ceil((d.extract.split(' ').length || 120) / 200)),
      category: categorizeArticle(d.title, d.extract),
      source: 'Wikipedia'
    };
  });

  return responses;
}

async function wikiSearchTitles(srsearch, limit = 50) {
  const resp = await axios.get('https://en.wikipedia.org/w/api.php', {
    timeout: 8000,
    headers: { 'User-Agent': 'HumanitiesFeed/1.0 (contact: you@example.com)' },
    params: {
      action: 'query',
      list: 'search',
      srsearch,
      srlimit: Math.min(limit, 50),
      format: 'json'
    }
  });
  const hits = resp?.data?.query?.search || [];
  return hits
    .map(h => h.title)
    .filter(t => !t.toLowerCase().includes('(disambiguation)'));
}

async function wikiSummariesForTitles(titles, concurrency = 4) {
  const requests = titles.map(title => ({
    url: `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`
  }));

  const results = await mapWithLimit(requests, concurrency, async (r) => {
    const resp = await axios.get(r.url, {
      timeout: 6000,
      headers: { 'User-Agent': 'HumanitiesFeed/1.0 (contact: you@example.com)' }
    });
    const d = resp.data;
    if (!d?.title) return null;

    return {
      id: `wiki-${d.pageid || encodeURIComponent(d.title)}`,
      title: d.title,
      extract: d.extract || '',
      thumbnail: d.thumbnail?.source || d.originalimage?.source || null,
      url: d.content_urls?.desktop?.page || `https://en.wikipedia.org/wiki/${encodeURIComponent(d.title)}`,
      type: d.description || 'Article',
      readTime: Math.max(1, Math.ceil(((d.extract || '').split(' ').length || 120) / 200)),
      category: categorizeArticle(d.title, d.extract || ''),
      source: 'Wikipedia'
    };
  });

  return results.filter(Boolean);
}

async function getCategoryMembers(cmtitle, cmtype = 'page|subcat', cmlimit = 200, cmcontinue) {
  const resp = await axios.get('https://en.wikipedia.org/w/api.php', {
    timeout: 10000,
    headers: { 'User-Agent': 'HumanitiesFeed/1.0 (contact: you@example.com)' },
    params: {
      action: 'query',
      list: 'categorymembers',
      cmtitle,
      cmtype,
      cmnamespace: 0,
      cmlimit: Math.min(cmlimit, 500),
      continue: '',
      cmcontinue,
      format: 'json'
    }
  });
  return resp.data;
}

async function crawlCategories(seedCategories, { maxDepth = 1, maxPages = 400 } = {}) {
  const seenCats = new Set();
  const pages = new Set();
  let queue = seedCategories.slice().map(c => ({ title: c, depth: 0 }));

  while (queue.length > 0 && pages.size < maxPages) {
    const { title, depth } = queue.shift();
    if (seenCats.has(title)) continue;
    seenCats.add(title);

    let cmcontinue;
    do {
      const data = await getCategoryMembers(title, 'page|subcat', 200, cmcontinue);
      const members = data?.query?.categorymembers || [];
      for (const m of members) {
        if (m.ns === 14) {
          if (depth < maxDepth) {
            queue.push({ title: `Category:${m.title.replace(/^Category:/, '')}`, depth: depth + 1 });
          }
        } else {
          pages.add(m.title);
          if (pages.size >= maxPages) break;
        }
      }
      cmcontinue = data?.continue?.cmcontinue;
    } while (cmcontinue && pages.size < maxPages);
  }

  return Array.from(pages);
}

async function fetchWikipediaByCategoryTopic(topicKey, count = 6) {
  const seedCats = WIKI_CATEGORY_TOPICS[topicKey];
  if (!seedCats) return null;

  const titles = await crawlCategories(seedCats, { maxDepth: 1, maxPages: 500 });
  if (!titles.length) return [];

  const pool = titles.slice();
  const sample = [];
  for (let i = 0; i < Math.min(count, pool.length); i++) {
    const idx = Math.floor(Math.random() * pool.length);
    sample.push(pool.splice(idx, 1)[0]);
  }
  return wikiSummariesForTitles(sample);
}

async function fetchWikipediaByTopic(topicKey, count = 6) {
  // Prefer category crawl
  try {
    const catResult = await fetchWikipediaByCategoryTopic(topicKey, count);
    if (Array.isArray(catResult) && catResult.length) return catResult;
  } catch (e) {
    console.error('Category crawl failed:', e?.message || e);
  }

  // Fallback: deepcat search
  const queries = WIKI_TOPICS[topicKey];
  if (queries && queries.length) {
    let pool = new Set();
    for (const q of queries) {
      try {
        const titles = await wikiSearchTitles(q, 50);
        titles.forEach(t => pool.add(t));
        if (pool.size > 300) break;
      } catch (e) {
        console.error('wikiSearchTitles error for', q, e.message);
      }
    }
    const list = Array.from(pool);
    if (list.length) {
      const sample = [];
      for (let i = 0; i < Math.min(count, list.length); i++) {
        const idx = Math.floor(Math.random() * list.length);
        sample.push(list.splice(idx, 1)[0]);
      }
      return wikiSummariesForTitles(sample);
    }
  }

  console.warn('No titles found for topic', topicKey, '—falling back to random');
  return fetchWikipediaArticles(count);
}

/**
 * =========================
 * SEP helpers
 * =========================
 */
async function sepListAllEntries() {
  const url = 'https://plato.stanford.edu/contents.html';
  const resp = await axios.get(url, {
    timeout: 10000,
    headers: { 'User-Agent': 'HumanitiesFeed/1.0 (contact: you@example.com)' }
  });
  const $ = cheerio.load(resp.data);

  const entries = [];
  $('a').each((_, a) => {
    const href = $(a).attr('href') || '';
    const text = $(a).text().trim();

    if ((href.startsWith('/entries/') || href.startsWith('entries/')) && text) {
      const absolute = new URL(href, 'https://plato.stanford.edu').toString();
      entries.push({ title: text, url: absolute });
    }
  });

  const seen = new Set();
  return entries.filter(e => {
    if (seen.has(e.url)) return false;
    seen.add(e.url);
    return true;
  });
}

async function sepFetchArticleCard(entryUrl) {
  const resp = await axios.get(entryUrl, {
    timeout: 10000,
    headers: { 'User-Agent': 'HumanitiesFeed/1.0 (contact: you@example.com)' }
  });
  const $ = cheerio.load(resp.data);

  const title =
    $('#aueditable h1').first().text().trim() ||
    $('h1').first().text().trim() ||
    'Stanford Encyclopedia Entry';

  const paras = $('#aueditable p')
    .slice(0, 3)
    .map((i, el) => $(el).text().trim())
    .get();

  const extract = (paras.join(' ') || '').substring(0, 600) + (paras.length ? '…' : '');

  return {
    id: `stanford-${encodeURIComponent(entryUrl)}`,
    title,
    extract,
    thumbnail: 'https://images.unsplash.com/photo-1481627834876-b7833e8f5570?w=400&h=300&fit=crop',
    url: entryUrl,
    type: 'Philosophy',
    readTime: Math.max(3, Math.ceil((extract.split(' ').length || 400) / 200)),
    category: 'early-modern',
    source: 'Stanford Encyclopedia'
  };
}

async function fetchStanfordArticles(count = 3) {
  try {
    const all = await sepListAllEntries();
    if (!all.length) {
      console.warn('[SEP] No entries found on contents page');
      return [];
    }

    const pool = all.slice();
    const chosen = [];
    for (let i = 0; i < Math.min(count, pool.length); i++) {
      const idx = Math.floor(Math.random() * pool.length);
      chosen.push(pool.splice(idx, 1)[0]);
    }

    const cards = await mapWithLimit(chosen, 3, async (entry) => {
      try {
        return await sepFetchArticleCard(entry.url);
      } catch (err) {
        console.error('[SEP] fetch error for', entry.url, err.message);
        return null;
      }
    });

    return cards.filter(Boolean);
  } catch (err) {
    console.error('[SEP] Failed to fetch random entries:', err.message);
    return [];
  }
}

/**
 * =========================
 * Smithsonian
 * =========================
 */
const SMITHSONIAN_CATEGORY_URLS = [
  'https://www.smithsonianmag.com/category/archaeology/',
  'https://www.smithsonianmag.com/category/us-history/',
  'https://www.smithsonianmag.com/category/world-history/',
  'https://www.smithsonianmag.com/category/arts-culture/',
  'https://www.smithsonianmag.com/category/history/'
];

let smithsonianDebug = [];

async function smithsonianListHistoryArticles() {
  const results = [];
  smithsonianDebug = [];

  for (const url of SMITHSONIAN_CATEGORY_URLS) {
    try {
      const resp = await axios.get(url, {
        timeout: 10000,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
            '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept':
            'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9'
        }
      });

      const html = resp.data || '';
      const $ = cheerio.load(html);

      const itemsForUrl = [];

      $('h2 a, h3 a').each((_, el) => {
        const title = $(el).text().trim();
        let href = $(el).attr('href') || '';
        if (!title || !href) return;

        const fullUrl = new URL(href, url).toString();
        if (fullUrl.includes('/category/') || fullUrl.includes('/tag/')) return;

        const summary =
          $(el).closest('h2, h3').next('p').text().trim() ||
          $(el).parent().next('p').text().trim();

        itemsForUrl.push({
          title,
          url: fullUrl,
          summary,
          thumbnail: null
        });
      });

      smithsonianDebug.push({
        url,
        ok: true,
        status: resp.status,
        length: html.length,
        itemsFound: itemsForUrl.length
      });

      console.log(`[Smithsonian] ${url} -> status ${resp.status}, itemsFound=${itemsForUrl.length}`);
      results.push(...itemsForUrl);
    } catch (err) {
      const msg = err.message || String(err);
      smithsonianDebug.push({ url, ok: false, error: msg });
      console.error(`[Smithsonian] Error fetching ${url}:`, msg);
    }
  }

  const seen = new Set();
  const deduped = results.filter(item => {
    if (seen.has(item.url)) return false;
    seen.add(item.url);
    return true;
  });

  console.log(`[Smithsonian] Total parsed items across categories: ${deduped.length}`);
  return deduped;
}

async function fetchSmithsonianArticles(count = 2) {
  try {
    const all = await smithsonianListHistoryArticles();
    if (!all.length) {
      console.warn('[Smithsonian] No articles parsed from any category');
      return [];
    }

    const pool = all.slice();
    const chosen = [];
    for (let i = 0; i < Math.min(count, pool.length); i++) {
      const idx = Math.floor(Math.random() * pool.length);
      chosen.push(pool.splice(idx, 1)[0]);
    }

    return chosen.map((item, idx) => ({
      id: `smith-${idx}-${encodeURIComponent(item.url)}`,
      title: item.title,
      extract: item.summary || 'From Smithsonian magazine’s history and culture sections.',
      thumbnail: null,
      url: item.url,
      type: 'History',
      readTime: 6,
      category: 'modern',
      source: 'Smithsonian'
    }));
  } catch (err) {
    console.error('[Smithsonian] Fetch error:', err.message || err);
    return [];
  }
}

/**
 * =========================
 * Main collector
 * =========================
 */
async function fetchAllArticles(topicKey) {
  const label = topicKey ? `(topic=${topicKey})` : '(all wiki topics)';
  console.log('Fetching fresh articles...', label);

  let wikiPromise;
  if (!topicKey) {
    const topicKeys = Object.keys(WIKI_CATEGORY_TOPICS);
    const PER_TOPIC = 3;
    wikiPromise = Promise.all(topicKeys.map(k => fetchWikipediaByTopic(k, PER_TOPIC)))
      .then(arrays => arrays.flat());
  } else {
    wikiPromise = fetchWikipediaByTopic(topicKey, 6);
  }

  const [wikiArticles, stanfordArticles, smithsonianArticles] = await Promise.all([
    wikiPromise,
    fetchStanfordArticles(3),
    fetchSmithsonianArticles(2)
  ]);

  return [...wikiArticles, ...stanfordArticles, ...smithsonianArticles];
}

/**
 * =========================
 * Routes
 * =========================
 */

// --- Shakespeare Sonnet (random) ---
app.get('/api/sonnet', async (req, res) => {
  try {
    const indexResp = await axios.get(SONNETS_INDEX_URL, {
      timeout: 10000,
      headers: { 'User-Agent': 'HumanitiesFeed/1.0 (contact: you@example.com)' }
    });

    const $ = cheerio.load(indexResp.data || '');

    const links = [];
    $('a[href]').each((_, a) => {
      const href = $(a).attr('href');
      if (href && /^sonnet\.[IVXLCDM]+\.html$/i.test(href)) links.push(href);
    });

    if (!links.length) {
      return res.status(500).json({ error: 'No sonnet links found on MIT index page' });
    }

    const pick = links[Math.floor(Math.random() * links.length)];
    const url = new URL(pick, SONNETS_BASE_URL).toString();

    const sonnetResp = await axios.get(url, {
      timeout: 10000,
      headers: { 'User-Agent': 'HumanitiesFeed/1.0 (contact: you@example.com)' }
    });

    const $$ = cheerio.load(sonnetResp.data || '');

    const title =
      $$('#aueditable h1').first().text().trim() ||
      $$('h1').first().text().trim() ||
      null;

    let text = normalizeSonnetText($$('blockquote').first().text());
    if (!text) text = normalizeSonnetText($$('pre').first().text());
    if (!text) text = normalizeSonnetText($$('body').text());

    const number = extractRomanFromHref(pick);

    return res.json({
      source: 'Shakespeare (MIT)',
      number,
      title,
      text,
      url
    });
  } catch (err) {
    console.error('[SONNET] Error:', err?.message || err);
    return res.status(500).json({ error: 'Failed to fetch sonnet' });
  }
});

// --- Articles ---
app.get('/api/articles', async (req, res) => {
  try {
    const now = Date.now();
    const force = String(req.query.force || '').toLowerCase();
    const bypass = force === '1' || force === 'true';
    const topicKey = String(req.query.topic || '').toLowerCase();

    if (!bypass && !topicKey && articleCache.length > 0 && (now - lastRefresh) < CACHE_DURATION) {
      console.log('Returning cached articles');
      return res.json({ articles: articleCache, cached: true });
    }

    const articles = await fetchAllArticles(topicKey || undefined);

    if (!topicKey) {
      articleCache = articles;
      lastRefresh = now;
    }

    res.json({ articles, cached: false, topic: topicKey || null });
  } catch (error) {
    console.error('Error fetching articles:', error);
    res.status(500).json({ error: 'Failed to fetch articles' });
  }
});

// --- Debugger for Stanford Content ---
app.get('/debug/stanford', async (req, res) => {
  try {
    const cards = await fetchStanfordArticles(3);
    res.json({ count: cards.length, cards });
  } catch (err) {
    console.error('[DEBUG /debug/stanford] error:', err);
    res.status(500).json({ error: err.message || String(err) });
  }
});

// --- Debugger for Smithsonian Content ---
app.get('/debug/smithsonian', async (req, res) => {
  try {
    const raw = await smithsonianListHistoryArticles();
    const cards = await fetchSmithsonianArticles(3);
    res.json({
      rawCount: raw.length,
      cardCount: cards.length,
      perUrl: smithsonianDebug,
      rawSample: raw.slice(0, 5),
      cards
    });
  } catch (err) {
    console.error('[DEBUG /debug/smithsonian] error:', err);
    res.status(500).json({ error: err.message || String(err) });
  }
});

// --- health & root ---
app.get('/health', (req, res) => {
  res.json({ status: 'ok', cacheSize: articleCache.length, lastRefresh });
});
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Historical Feed API is running' });
});

/**
 * =========================
 * Start server
 * =========================
 */
console.log(`[BOOT] Starting Historical Feed API... (node ${process.version})`);
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[BOOT] Listening on 0.0.0.0:${PORT}`);
  if (String(process.env.PREFETCH_ON_START).toLowerCase() === 'true') {
    console.log('[BOOT] Prefetching initial articles...');
    fetchAllArticles()
      .then(articles => {
        articleCache = articles;
        lastRefresh = Date.now();
        console.log(`[BOOT] Prefetch loaded ${articles.length} articles`);
      })
      .catch(err => {
        console.error('[BOOT] Prefetch failed:', err?.message || err);
      });
  } else {
    console.log('[BOOT] Skipping prefetch (PREFETCH_ON_START not true)');
  }
});
