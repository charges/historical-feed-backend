// server.js - Historical Feed Backend
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const axiosRetry = require('axios-retry');

const app = express();

// --- Wikipedia topic presets (search-based deepcat fallback) ---
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
};

// --- Category-first topic map (preferred) ---
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
  ]
};

// --- Crash logging ---
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err);
});
process.on('unhandledRejection', (reason, p) => {
  console.error('[FATAL] Unhandled Rejection at:', p, 'reason:', reason);
});

const PORT = process.env.PORT || 3000;

// --- Axios retry/backoff (global) ---
axiosRetry(axios, {
  retries: 3,
  retryDelay: (retryCount, error) => {
    const retryAfter = Number(error?.response?.headers?.['retry-after']);
    if (!Number.isNaN(retryAfter)) return retryAfter * 1000;
    return Math.min(1000 * 2 ** (retryCount - 1), 8000); // 1s,2s,4s, capped 8s
  },
  retryCondition: (error) => {
    if (error.code === 'ECONNABORTED') return true;
    const s = error?.response?.status;
    return s === 429 || s === 503 || s === 502 || s === 504;
  },
});

// --- Middleware ---
app.use(cors()); // consider: cors({ origin: ['https://charges.github.io', 'http://localhost:8080'] })
app.use(express.json());

// --- In-memory cache (1 hour) ---
let articleCache = [];
let lastRefresh = 0;
const CACHE_DURATION = 3600000; // 1 hour

// --- tiny concurrency limiter ---
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

// --- Wikipedia RANDOM fetcher (fallback) ---
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

// --- Wikipedia: search helper (deepcat fallback) ---
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

// --- Wikipedia: summaries for given titles ---
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

// --- Wikipedia: CategoryMembers crawl (topic-first) ---
async function getCategoryMembers(cmtitle, cmtype = 'page|subcat', cmlimit = 200, cmcontinue) {
  const resp = await axios.get('https://en.wikipedia.org/w/api.php', {
    timeout: 10000,
    headers: { 'User-Agent': 'HumanitiesFeed/1.0 (contact: you@example.com)' },
    params: {
      action: 'query',
      list: 'categorymembers',
      cmtitle,
      cmtype,
      cmnamespace: 0, // main/article space
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
        if (m.ns === 14) { // subcategory
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
  if (!seedCats) return null; // let caller decide fallback

  const titles = await crawlCategories(seedCats, { maxDepth: 1, maxPages: 500 });
  if (!titles.length) return [];

  // sample `count`
  const pool = titles.slice();
  const sample = [];
  for (let i = 0; i < Math.min(count, pool.length); i++) {
    const idx = Math.floor(Math.random() * pool.length);
    sample.push(pool.splice(idx, 1)[0]);
  }
  return wikiSummariesForTitles(sample);
}

// --- Wikipedia: topic dispatcher (category-first, deepcat fallback, then random) ---
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

  // Last resort: random
  console.warn('No titles found for topic', topicKey, '—falling back to random');
  return fetchWikipediaArticles(count);
}

// --- SEP helpers ---
// Crawl the main SEP contents page and return an array of { title, url }
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

    // accept both "entries/..." and "/entries/..."
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

// Fetch a single SEP article card (title/extract/url/etc.)
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

// --- Stanford Encyclopedia (random, not topic-filtered) ---
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

const SMITHSONIAN_CATEGORY_URLS = [
  'https://www.smithsonianmag.com/category/archaeology/',
  'https://www.smithsonianmag.com/category/us-history/',
  'https://www.smithsonianmag.com/category/world-history/',
  'https://www.smithsonianmag.com/category/arts-culture/'
];

// Scrape the Smithsonian History category page for article cards
async function smithsonianListHistoryArticles() {
  // Use the category URL (history index)
  const url = 'https://www.smithsonianmag.com/category/history/';

  const resp = await axios.get(url, {
    timeout: 10000,
    headers: {
      // Pretend to be a normal browser so we don't get a bare/JS-only page
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept':
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9'
    }
  });

  const $ = cheerio.load(resp.data);
  const items = [];

  // Each history story appears as a "### <a>Title</a>" in an <h3>
  $('h3 a').each((_, el) => {
    const title = $(el).text().trim();
    let href = $(el).attr('href') || '';
    if (!title || !href) return;

    // Normalize to absolute URL
    const fullUrl = new URL(href, url).toString();

    // Grab the first paragraph after this heading as a summary, if present
    const summary =
      $(el).closest('h3').nextUntil('h3', 'p').first().text().trim() ||
      '';

    // Try to find a nearby image: usually a preceding <a><img/></a>
    let imgSrc = null;
    const imgCandidate = $(el)
      .closest('h3')
      .prevAll('a')
      .has('img')
      .first()
      .find('img');

    if (imgCandidate.length) {
      imgSrc =
        imgCandidate.attr('data-src') ||
        imgCandidate.attr('src') ||
        null;
      if (imgSrc) {
        imgSrc = new URL(imgSrc, url).toString();
      }
    }

    items.push({
      title,
      url: fullUrl,
      summary,
      thumbnail: imgSrc || null
    });
  });

  // De-duplicate by URL
  const seen = new Set();
  return items.filter(item => {
    if (seen.has(item.url)) return false;
    seen.add(item.url);
    return true;
  });
}

async function fetchSmithsonianArticles(count = 2) {
  try {
    const all = await smithsonianListHistoryArticles();

    if (!all.length) {
      console.warn('[Smithsonian] No articles parsed from History index');
      return [];
    }

    // Randomly sample `count` articles from the list
    const pool = all.slice();
    const chosen = [];
    for (let i = 0; i < Math.min(count, pool.length); i++) {
      const idx = Math.floor(Math.random() * pool.length);
      chosen.push(pool.splice(idx, 1)[0]);
    }

    return chosen.map((item, idx) => ({
      id: `smith-${idx}-${encodeURIComponent(item.url)}`,
      title: item.title,
      extract:
        item.summary ||
        'From Smithsonian magazine’s History section.',
      thumbnail: item.thumbnail || null,   // <-- use scraped image if present
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

    return cards.filter(Boolean);
  } catch (err) {
    console.error('[Smithsonian] Fetch error:', err.message || err);
    return [];
  }
}

// --- Categorization helpers ---
function categorizeArticle(title, text) {
  const content = (title + ' ' + text).toLowerCase();
  if (content.match(/ancient|egypt|greek|roman|mesopotamia|bc|bce/)) return 'ancient';
  if (content.match(/medieval|middle ages|feudal|crusade|viking/)) return 'medieval';
  if (content.match(/renaissance|reformation|enlightenment|1400|1500|1600|1700/)) return 'early-modern';
  if (content.match(/industrial|revolution|1800|1900|20th century|war|modern/)) return 'modern';
  if (content.match(/technology|invention|computer|press|printing/)) return 'technology';
  return 'ancient';
}
function categorizeByTopic(topic) {
  if (topic.includes('ancient') || topic.includes('plato') || topic.includes('stoicism')) return 'ancient';
  if (topic.includes('medieval')) return 'medieval';
  if (topic.includes('enlightenment') || topic.includes('descartes')) return 'early-modern';
  return 'ancient';
}

// --- Main collector ---
async function fetchAllArticles(topicKey) {
  const label = topicKey ? `(topic=${topicKey})` : '(all wiki topics)';
  console.log('Fetching fresh articles...', label);

  let wikiPromise;
  if (!topicKey) {
    const topicKeys = Object.keys(WIKI_CATEGORY_TOPICS);
    const PER_TOPIC = 3;
    wikiPromise = Promise.all(
      topicKeys.map(k => fetchWikipediaByTopic(k, PER_TOPIC))
    ).then(arrays => arrays.flat());
  } else {
    wikiPromise = fetchWikipediaByTopic(topicKey, 6);
  }

  const [wikiArticles, stanfordArticles, smithsonianArticles] = await Promise.all([
    wikiPromise,
    fetchStanfordArticles(3),
    fetchSmithsonianArticles(2)
  ]);

  return [
    ...wikiArticles,
    ...stanfordArticles,
    ...smithsonianArticles
  ];
}

// --- API endpoint ---
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

// --- Start server ---
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
