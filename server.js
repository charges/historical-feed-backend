// server.js - Historical Feed Backend
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS for your frontend
app.use(cors());
app.use(express.json());

// Cache for scraped articles (refreshes every hour)
let articleCache = [];
let lastRefresh = 0;
const CACHE_DURATION = 3600000; // 1 hour in milliseconds

// Wikipedia API fetcher
async function fetchWikipediaArticles(count = 5) {
  const articles = [];
  
  for (let i = 0; i < count; i++) {
    try {
      const response = await axios.get(
        'https://en.wikipedia.org/api/rest_v1/page/random/summary'
      );
      
      if (response.data && response.data.extract) {
        articles.push({
          id: `wiki-${response.data.pageid}`,
          title: response.data.title,
          extract: response.data.extract,
          thumbnail: response.data.thumbnail?.source || response.data.originalimage?.source || null,
          url: response.data.content_urls?.desktop?.page,
          type: response.data.description || 'Article',
          readTime: Math.max(1, Math.ceil(response.data.extract.split(' ').length / 200)),
          category: categorizeArticle(response.data.title, response.data.extract),
          source: 'Wikipedia'
        });
      }
    } catch (error) {
      console.error('Wikipedia fetch error:', error.message);
    }
  }
  
  return articles;
}

// Stanford Encyclopedia scraper
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
      const response = await axios.get(
        `https://plato.stanford.edu/entries/${topic}/`,
        { timeout: 5000 }
      );
      
      const $ = cheerio.load(response.data);
      const title = $('#aueditable h1').first().text() || $('h1').first().text();
      const paragraphs = $('#aueditable p').slice(0, 3).map((i, el) => $(el).text()).get();
      const extract = paragraphs.join(' ').substring(0, 500) + '...';
      
      if (title && extract) {
        articles.push({
          id: `stanford-${topic}`,
          title: title,
          extract: extract,
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

// Britannica scraper (simplified - Britannica has anti-scraping)
async function fetchBritannicaArticles(count = 2) {
  // Britannica blocks scraping, so we'll return curated content
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

// Smithsonian fetcher
async function fetchSmithsonianArticles(count = 2) {
  const curatedArticles = [
    {
      id: 'smith-tut',
      title: 'The Discovery of King Tut\'s Tomb',
      extract: 'In 1922, British archaeologist Howard Carter made one of the most spectacular discoveries in archaeological history: the nearly intact tomb of Pharaoh Tutankhamun in Egypt\'s Valley of the Kings. Unlike most royal tombs, which had been plundered in antiquity, King Tut\'s burial chamber contained over 5,000 artifacts.',
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
      extract: 'Archaeological evidence confirms that Norse Vikings, led by Leif Erikson, established settlements in North America around 1000 CE, nearly 500 years before Columbus. The L\'Anse aux Meadows site in Newfoundland reveals buildings, tools, and evidence of iron working characteristic of Norse culture.',
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

// Helper function to categorize articles
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

// Main fetch function
async function fetchAllArticles() {
  console.log('Fetching fresh articles...');
  
  const [wikiArticles, stanfordArticles, britannicaArticles, smithsonianArticles] = await Promise.all([
    fetchWikipediaArticles(6),
    fetchStanfordArticles(3),
    fetchBritannicaArticles(2),
    fetchSmithsonianArticles(2)
  ]);
  
  return [
    ...wikiArticles,
    ...stanfordArticles,
    ...britannicaArticles,
    ...smithsonianArticles
  ];
}

// API endpoint
app.get('/api/articles', async (req, res) => {
  try {
    const now = Date.now();
    
    // Return cached articles if still fresh
    if (articleCache.length > 0 && (now - lastRefresh) < CACHE_DURATION) {
      console.log('Returning cached articles');
      return res.json({ articles: articleCache, cached: true });
    }
    
    // Fetch fresh articles
    const articles = await fetchAllArticles();
    articleCache = articles;
    lastRefresh = now;
    
    res.json({ articles, cached: false });
  } catch (error) {
    console.error('Error fetching articles:', error);
    res.status(500).json({ error: 'Failed to fetch articles' });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', cacheSize: articleCache.length });
});

// Add this after the existing /health route
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Historical Feed API' });
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Historical Feed API running on port ${PORT}`);
  
  // Fetch initial articles
  fetchAllArticles().then(articles => {
    articleCache = articles;
    lastRefresh = Date.now();
    console.log(`Loaded ${articles.length} initial articles`);
  });
});
