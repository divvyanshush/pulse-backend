import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import Parser from "rss-parser";

const app    = express();
const parser = new Parser({ timeout: 10000 });
const PORT   = 3001;

app.use(cors({ origin: "*" }));
app.use(express.json());

const CACHE = { items: [], lastFetch: 0 };
const CACHE_TTL = 60_000;

// ── AI keyword filter ─────────────────────────────────────────────
const AI_KW = [
  "llm","gpt","claude","gemini","openai","anthropic","mistral","llama","ai ",
  " ai,","artificial intelligence","machine learning","deep learning","neural",
  "diffusion","transformer","fine-tun","rlhf","rag","embedding","inference",
  "language model","multimodal","stable diffusion","deepmind","groq","hugging face",
  "perplexity","chatgpt","copilot","midjourney","sora","nvidia","foundation model",
  "generative","large model","text-to","image-to","vector database","autonomous",
  "alignment","reinforcement learning","computer vision","nlp","natural language",
];
const isAI = t => { const s=(t||"").toLowerCase(); return AI_KW.some(k=>s.includes(k)); };

const guessType = t => {
  const s=(t||"").toLowerCase();
  if (/raise|fund|series [abcde]|valuation|billion|million|invest/.test(s)) return "funding";
  if (/release|launch|open.?source|weights|v\d\.|checkpoint|introduces|announc|new model/.test(s)) return "model";
  if (/paper|arxiv|research|study|benchmark|dataset|findings|survey|experiment/.test(s)) return "research";
  if (/resign|leak|fire|contro|drama|allegat|scandal|lawsuit|dispute/.test(s)) return "drama";
  if (/policy|regulation|eu |senate|law|ban|govern|compli|legal/.test(s)) return "policy";
  return "product";
};

const heatScore = (score, comments, src) => {
  const base = src==="HN" ? Math.min(score/4,65)
             : src==="Dev.to" ? Math.min(score/2,65)
             : src==="GitHub" ? Math.min(score/10,65)
             : 40;
  return Math.min(Math.round(base + Math.min((comments||0)/3, 35)), 99);
};

const safeText = t => (t||"").replace(/<[^>]+>/g,"").replace(/\s+/g," ").trim();

// ── FETCHERS ──────────────────────────────────────────────────────

// 1. Hacker News
async function fetchHN() {
  const res = await fetch("https://hacker-news.firebaseio.com/v0/topstories.json", {signal:AbortSignal.timeout(10000)});
  const ids = (await res.json()).slice(0, 80);
  const rows = await Promise.allSettled(ids.map(id =>
    fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`, {signal:AbortSignal.timeout(6000)}).then(r=>r.json())
  ));
  return rows
    .filter(r => r.status==="fulfilled" && r.value?.title && isAI(r.value.title+(r.value.text||"")))
    .map(({value:s}) => ({
      id:`hn-${s.id}`, src:"HN", type:guessType(s.title), title:s.title,
      sum: s.text ? safeText(s.text).slice(0,220)+"…" : "Discussion on Hacker News.",
      link: s.url||`https://news.ycombinator.com/item?id=${s.id}`,
      time:s.time, score:s.score||0, comments:s.descendants||0,
    }));
}

// 2. arXiv
async function fetchArxiv() {
  const res = await fetch("https://export.arxiv.org/api/query?search_query=cat:cs.AI+OR+cat:cs.LG+OR+cat:cs.CL+OR+cat:cs.CV&sortBy=lastUpdatedDate&sortOrder=descending&max_results=40", {signal:AbortSignal.timeout(12000)});
  const text = await res.text();
  const entries = text.split("<entry>").slice(1);
  return entries.map(e => {
    const get = tag => { const m=e.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`)); return m?m[1].trim():""; };
    const title   = get("title").replace(/\n/g," ").trim();
    const summary = safeText(get("summary")).slice(0,240)+"…";
    const link    = (e.match(/<id>([\s\S]*?)<\/id>/)||[])[1]?.trim()||"https://arxiv.org";
    const pub     = (e.match(/<published>([\s\S]*?)<\/published>/)||[])[1]?.trim();
    const time    = pub ? Math.floor(new Date(pub).getTime()/1000) : Math.floor(Date.now()/1000);
    const authors = (e.match(/<name>([\s\S]*?)<\/name>/g)||[]).slice(0,3).map(a=>a.replace(/<\/?name>/g,"")).join(", ");
    return { id:`arxiv-${link.split("/abs/")[1]||Math.random()}`, src:"arXiv", type:"research", title, sum:summary, link, time, score:0, comments:0, authors };
  }).filter(e=>e.title);
}

// 3. Dev.to
async function fetchDevTo() {
  const res = await fetch("https://dev.to/api/articles?tag=ai&per_page=30&top=1", {signal:AbortSignal.timeout(10000)});
  const json = await res.json();
  return (json||[]).filter(a=>isAI(a.title+(a.description||""))).map(a=>({
    id:`devto-${a.id}`, src:"Dev.to", type:guessType(a.title), title:a.title,
    sum: safeText(a.description||"").slice(0,220)+"…",
    link:a.url, time:Math.floor(new Date(a.published_at).getTime()/1000),
    score:a.positive_reactions_count||0, comments:a.comments_count||0,
  }));
}

// 4. Dev.to ML tag
async function fetchDevToML() {
  const res = await fetch("https://dev.to/api/articles?tag=machinelearning&per_page=20&top=1", {signal:AbortSignal.timeout(10000)});
  const json = await res.json();
  return (json||[]).filter(a=>isAI(a.title+(a.description||""))).map(a=>({
    id:`devto-ml-${a.id}`, src:"Dev.to", type:guessType(a.title), title:a.title,
    sum: safeText(a.description||"").slice(0,220)+"…",
    link:a.url, time:Math.floor(new Date(a.published_at).getTime()/1000),
    score:a.positive_reactions_count||0, comments:a.comments_count||0,
  }));
}

// 5. Lobste.rs
async function fetchLobsters() {
  const res = await fetch("https://lobste.rs/t/ai.json", {signal:AbortSignal.timeout(10000)});
  const json = await res.json();
  return (json||[]).map(s=>({
    id:`lobsters-${s.short_id}`, src:"Lobste.rs", type:guessType(s.title), title:s.title,
    sum:`${s.description||"Technical discussion on Lobste.rs."}`.slice(0,220),
    link:s.url||`https://lobste.rs/s/${s.short_id}`,
    time:Math.floor(new Date(s.created_at).getTime()/1000),
    score:s.score||0, comments:s.comment_count||0,
  }));
}

// 6. GitHub Trending (scrape JSON)
async function fetchGitHub() {
  const res = await fetch("https://api.github.com/search/repositories?q=topic:llm+topic:artificial-intelligence&sort=stars&order=desc&per_page=20", {
    headers:{"Accept":"application/vnd.github.v3+json","User-Agent":"pulse-app/1.0"},
    signal:AbortSignal.timeout(10000)
  });
  const json = await res.json();
  return (json?.items||[]).map(r=>({
    id:`github-${r.id}`, src:"GitHub", type:"model", title:`⭐ ${r.full_name} — ${r.description||""}`.slice(0,120),
    sum:(r.description||"No description.").slice(0,220),
    link:r.html_url, time:Math.floor(new Date(r.updated_at).getTime()/1000),
    score:r.stargazers_count||0, comments:r.forks_count||0,
  }));
}

// 7. RSS helper
async function fetchRSS(url, src, srcLabel) {
  const feed = await parser.parseURL(url);
  return (feed.items||[])
    .filter(e=>isAI((e.title||"")+(e.contentSnippet||e.summary||"")))
    .map(e=>({
      id:`${src.toLowerCase().replace(/\s/g,"-")}-${Buffer.from(e.link||e.title||"").toString("base64").slice(0,16)}`,
      src, srcLabel:srcLabel||src, type:guessType(e.title||""),
      title:(e.title||"").replace(/\n/g," ").trim(),
      sum:safeText(e.contentSnippet||e.summary||e.content||"").slice(0,240)+"…",
      link:e.link||"", time:e.pubDate?Math.floor(new Date(e.pubDate).getTime()/1000):Math.floor(Date.now()/1000),
      score:0, comments:0, authors:e.creator||e.author||"",
    }));
}

const RSS_SOURCES = [
  // Company blogs
  { url:"https://openai.com/blog/rss.xml",                src:"OpenAI",      label:"OpenAI Blog" },
  { url:"https://www.anthropic.com/news/rss.xml",              src:"Anthropic",   label:"Anthropic Blog" },
  { url:"https://deepmind.google/blog/rss/feed.xml",     src:"DeepMind",    label:"DeepMind Blog" },
  { url:"https://huggingface.co/blog/feed.xml",           src:"HuggingFace", label:"HuggingFace Blog" },
  // News
  { url:"https://venturebeat.com/category/ai/feed/",      src:"VentureBeat", label:"VentureBeat AI" },
  { url:"https://techcrunch.com/category/artificial-intelligence/feed/", src:"TechCrunch", label:"TechCrunch AI" },
  { url:"https://www.theverge.com/rss/ai-artificial-intelligence/index.xml", src:"TheVerge", label:"The Verge AI" },
  { url:"https://www.wired.com/feed/tag/ai/latest/rss",   src:"Wired",       label:"Wired AI" },
  { url:"https://www.technologyreview.com/feed/",         src:"MITReview",   label:"MIT Tech Review" },
  { url:"https://feed.infoq.com/",        src:"InfoQ",       label:"InfoQ" },
];

// ── Main aggregator ────────────────────────────────────────────────
async function fetchAll() {
  console.log("🔄 Fetching all sources…");

  const results = await Promise.allSettled([
    fetchHN(),
    fetchArxiv(),
    fetchDevTo(),
    fetchDevToML(),
    fetchLobsters(),
    fetchGitHub(),
    ...RSS_SOURCES.map(s => fetchRSS(s.url, s.src, s.label)),
  ]);

  const labels = ["HN","arXiv","Dev.to(AI)","Dev.to(ML)","Lobste.rs","GitHub",...RSS_SOURCES.map(s=>s.label)];

  const items = results
    .filter(r => r.status==="fulfilled")
    .flatMap(r => r.value)
    .map(i => ({ ...i, heat: heatScore(i.score, i.comments, i.src) }));

  results.forEach((r,i) => {
    if(r.status==="rejected") console.warn(`⚠  ${labels[i]} failed:`, r.reason?.message);
    else console.log(`✓  ${labels[i]}: ${r.value.length} items`);
  });

  // Deduplicate
  const seen = new Set();
  const unique = items.filter(i => {
    if(!i.title || seen.has(i.id)) return false;
    seen.add(i.id); return true;
  });

  unique.sort((a,b) => b.time - a.time);
  console.log(`✅ Total: ${unique.length} items\n`);
  return unique;
}

// ── Routes ─────────────────────────────────────────────────────────
app.get("/feed", async (req, res) => {
  try {
    const now = Date.now();
    if (now - CACHE.lastFetch < CACHE_TTL && CACHE.items.length > 0) {
      return res.json({ items: CACHE.items, cached: true, age: Math.round((now-CACHE.lastFetch)/1000) });
    }
    CACHE.items     = await fetchAll();
    CACHE.lastFetch = Date.now();
    res.json({ items: CACHE.items, cached: false, age: 0 });
  } catch(err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/health", (_, res) => res.json({ ok:true, items:CACHE.items.length, lastFetch:CACHE.lastFetch }));

// Keep-alive + auto refresh cache every 5 minutes
setInterval(async () => {
  try {
    console.log("🔄 Auto-refreshing cache…");
    CACHE.items = await fetchAll();
    CACHE.lastFetch = Date.now();
    console.log(`✅ Cache refreshed — ${CACHE.items.length} items`);
  } catch(e) {
    console.error("Auto-refresh failed:", e.message);
  }
}, 5 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`\n🚀 Pulse backend — http://localhost:${PORT}\n`);
  fetchAll().then(items => { CACHE.items=items; CACHE.lastFetch=Date.now(); });
});