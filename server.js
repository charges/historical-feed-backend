// server.js - Historical Feed Backend
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const axiosRetry = require('axios-retry');

const app = express();

// --- Crash logging (surface hidden errors) ---
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
app.use(cors()); // for prod, consider: cors({ origin: ['https://charges.github.io', 'http://localhost:8080'] })
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

// --- Wikipedia fetcher (parallel with cap) ---
async function fetchWikipediaArticles(count = 6, concurrency = 4) {
  const requests = Array.from({ length: count }, () => ({
    url: 'https://en.wikipedia.org/api/rest_v1/page/random/summary'
  }));

  const responses = await mapWithLimit(requests, concurrency, async (r) => {
    const resp = await axios.get(r.url, {
      timeout: 5000,
      headers: {
        'User-Agent': 'HumanitiesFeed/1.0 (contact: you@example.com)'
      }
    });
    const d = resp.data;
    if (!d?.extract) return null;
    return {
      id: `wiki-${d.pageid}`,
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

// --- Stanford Encyclopedia scraper ---
async function fetchStanfordArticles(count = 3) {
  const articles = [];
  const topics = [
    'ancient-skepticism',
    'conscience-medieval',
    'enlightenment',
    'stoicism',
    'descartes-epistemology',
    'plato'
  ];
  const selectedTopics = topics.sort(() => Math.random() - 0.5).slice(0, count);

  for (const topic of selectedTopics) {
    try {
      const response = await axios.get(`https://plato.stanford.edu/entries/${topic}/`, { timeout: 5000 });
      const $ = cheerio.load(response.data);
      const title = $('#aueditable h1').first().text() || $('h1').first().text();
      const paragraphs = $('#aueditable p').slice(0, 3).map((i, el) => $(el).text()).get();
      const extract = paragraphs.join(' ').substring(0, 500) + '...';

      if (title && extract) {
        articles.push({
          id: `stanford-${topic}`,
          title,
          extract,
          thumbnail: 'https://images.unsplash.com/photo-1481627834876-b7833e8f5570?w=400&h=300&fit=crop',
          url: `https://plato.stanford.edu/entries/${topic}/`,
          type: 'Philosophy',
          readTime: 7,
          category: categorizeByTopic(topic),
          source: 'Stanford Encyclopedia'
        });
      }
    } catch (error) {
      console.error(`Stanford fetch error for ${topic}:`, error.message);
    }
  }
  return articles;
}

// --- Britannica (curated) ---
async function fetchBritannicaArticles(count = 2) {
  const curatedArticles = [
    {
      id: 'brit-renaissance',
      title: 'The Renaissance',
      extract: 'The Renaissance, spanning the 14th to 17th centuries, marked a cultural rebirth in Europe characterized by renewed interest in classical learning and humanism. Beginning in Italy, it brought revolutionary developments in art, with masters like Leonardo da Vinci and Michelangelo, and transformed literature, science, and philosophy.',
      thumbnail: 'https://images.unsplash.com/photo-1549834125-82d3c48159a3?w=400&h=300&fit=crop',
      url: 'https://www.britannica.com/event/Renaissance',
      type: 'Cultural History',
      readTime: 7,
      category: 'early-modern',
      source: 'Britannica'
    },
    {
      id: 'brit-mesopotamia',
      title: 'Mesopotamian Civilization',
      extract: 'Mesopotamia, the land between the Tigris and Euphrates rivers, is often called the cradle of civilization. Here, around 3500 BCE, the Sumerians developed one of the world\'s first writing systems (cuneiform), built the first cities, and created complex irrigation systems.',
      thumbnail: 'https://images.unsplash.com/photo-1580674285054-bed31e145f59?w=400&h=300&fit=crop',
      url: 'https://www.britannica.com/place/Mesopotamia-historical-region-Asia',
      type: 'Ancient Civilization',
      readTime: 6,
      category: 'ancient',
      source: 'Britannica'
    }
  ];
  return curatedArticles.slice(0, count);
}

// --- Smithsonian (curated) ---
async function fetchSmithsonianArticles(count = 2) {
  const curatedArticles = [
    {
      id: 'smith-tut',
      title: 'The Discovery of King Tut\'s Tomb',
      extract: 'In 1922, British archaeologist Howard Carter made one of the most spectacular discoveries in archaeological history: the nearly intact tomb of Pharaoh Tutankhamun in Egypt\'s Valley of the Kings...',
      thumbnail: 'https://images.unsplash.com/photo-1539768942893-daf53e448371?w=400&h=300&fit=crop',
      url: 'https://www.smithsonianmag.com/history/archaeology/',
      type: 'Archaeology',
      readTime: 6,
      category: 'ancient',
      source: 'Smithsonian'
    },
    {
      id: 'smith-vikings',
      title: 'The Vikings in North America',
      extract: 'Archaeological evidence confirms that Norse Vikings, led by Leif Erikson, established settlements in North America around 1000 CE...',
      thumbnail: 'https://images.unsplash.com/photo-1583952734649-db24dc49ae80?w=400&h=300&fit=crop',
      url: 'https://www.smithsonianmag.com/history/vikings/',
      type: 'Exploration',
      readTime: 5,
      category: 'medieval',
      source: 'Smithsonian'
    }
  ];
  return curatedArticles.slice(0, count);
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
async function fetchAllArticles() {
  console.log('Fetching fresh articles...');
  const [wikiArticles, stanfordArticles, britannicaArticles, smithsonianArticles] = await Promise.all([
    fetchWikipediaArticles(6),   // parallelized internally
    fetchStanfordArticles(3),
    fetchBritannicaArticles(2),
    fetchSmithsonianArticles(2)
  ]);
  return [...wikiArticles, ...stanfordArticles, ...britannicaArticles, ...smithsonianArticles];
}

// --- API endpoint ---
app.get('/api/articles', async (req, res) => {
  try {
    const now = Date.now();
    const force = String(req.query.force || '').toLowerCase();
    const bypass = force === '1' || force === 'true';

    if (!bypass && articleCache.length > 0 && (now - lastRefresh) < CACHE_DURATION) {
      console.log('Returning cached articles');
      return res.json({ articles: articleCache, cached: true });
    }

    const articles = await fetchAllArticles();
    articleCache = articles;
    lastRefresh = now;
    res.json({ articles, cached: false });
  } catch (error) {
    console.error('Error fetching articles:', error);
    res.status(500).json({ error: 'Failed to fetch articles' });
  }
});

// --- health & root (handy on Render) ---
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

  // Optional prefetch: enable by setting PREFETCH_ON_START=true in Render env vars
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
