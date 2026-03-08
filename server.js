import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import Parser from "rss-parser";

const app = express();
const parser = new Parser();
const PORT = 3001;

app.use(cors());
app.use(express.json());

const CACHE = { items: [], lastFetch: 0 };
const CACHE_TTL = 60_000;

const AI_KW = ["llm","gpt","claude","gemini","openai","anthropic","mistral","llama","ai ","artificial intelligence","machine learning","deep learning","neural","diffusion","transformer","fine-tun","rlhf","rag","embedding","inference","language model","multimodal","stable diffusion","deepmind","groq","perplexity","chatgpt","copilot","midjourney","sora","nvidia","hugging face"];
const isAI = t => { const s=(t||"").toLowerCase(); return AI_KW.some(k=>s.includes(k)); };

const guessType = t => {
  const s=(t||"").toLowerCase();
  if (/raise|fund|series [abcde]|valuation|billion|million/.test(s)) return "funding";
  if (/release|launch|open.?source|weights|v\d\.|checkpoint|introduces/.test(s)) return "model";
  if (/paper|arxiv|research|study|benchmark|dataset|findings/.test(s)) return "research";
  if (/resign|leak|fire|contro|drama|allegat|scandal/.test(s)) return "drama";
  if (/policy|regulation|eu |senate|law|ban|govern/.test(s)) return "policy";
  return "product";
};

const heatScore = (score, comments, src) => {
  const base = src==="HN" ? Math.min(score/4,65) : src==="Reddit" ? Math.min(score/30,65) : 35;
  return Math.min(Math.round(base + Math.min((comments||0)/3, 35)), 99);
};

async function fetchHN() {
  const res = await fetch("https://hacker-news.firebaseio.com/v0/topstories.json");
  const ids = (await res.json()).slice(0, 80);
  const rows = await Promise.allSettled(ids.map(id => fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`).then(r=>r.json())));
  return rows.filter(r => r.status==="fulfilled" && r.value?.title && isAI(r.value.title+(r.value.text||""))).map(({ value: s }) => ({
    id:`hn-${s.id}`, src:"HN", type:guessType(s.title), title:s.title,
    sum: s.text ? s.text.replace(/<[^>]+>/g,"").slice(0,220)+"…" : "Discussion on Hacker News.",
    link: s.url || `https://news.ycombinator.com/item?id=${s.id}`,
    time:s.time, score:s.score||0, comments:s.descendants||0,
  }));
}

async function fetchRedditSub(sub) {
  const res = await fetch(`https://www.reddit.com/r/${sub}/hot.json?limit=30&raw_json=1`, { headers: { "User-Agent": "pulse-app/1.0" } });
  const json = await res.json();
  return (json?.data?.children || []).map(c=>c.data).filter(p => p && isAI(p.title+(p.selftext||""))).map(p => ({
    id:`reddit-${p.id}`, src:"Reddit", srcLabel:`r/${sub}`, type:guessType(p.title), title:p.title,
    sum: p.selftext?.trim() ? p.selftext.slice(0,220)+"…" : `Hot on r/${sub}.`,
    link:`https://reddit.com${p.permalink}`, time:p.created_utc, score:p.score||0, comments:p.num_comments||0,
  }));
}

async function fetchArxiv() {
  const feed = await parser.parseURL("https://export.arxiv.org/rss/cs.AI+cs.LG+cs.CL+cs.CV");
  return (feed.items || []).map(e => ({
    id:`arxiv-${(e.link||"").split("/abs/")[1]||Math.random()}`, src:"arXiv", type:"research",
    title:(e.title||"").replace(/\n/g," ").trim(),
    sum:(e.contentSnippet||e.summary||"").slice(0,240)+"…",
    link:e.link||"https://arxiv.org",
    time:e.pubDate ? Math.floor(new Date(e.pubDate).getTime()/1000) : Math.floor(Date.now()/1000),
    score:0, comments:0, authors:e.creator||"",
  }));
}

async function fetchAll() {
  const SUBS = ["MachineLearning","artificial","LocalLLaMA"];
  const results = await Promise.allSettled([fetchHN(), ...SUBS.map(fetchRedditSub), fetchArxiv()]);
  const items = results.filter(r=>r.status==="fulfilled").flatMap(r=>r.value).map(i=>({...i, heat:heatScore(i.score,i.comments,i.src)}));
  const seen = new Set();
  const unique = items.filter(i => { if(seen.has(i.id)) return false; seen.add(i.id); return true; });
  unique.sort((a,b) => b.time - a.time);
  const labels = ["HN", ...SUBS.map(s=>`r/${s}`), "arXiv"];
  results.forEach((r,i) => { if(r.status==="rejected") console.warn(`⚠  ${labels[i]} failed:`, r.reason?.message); else console.log(`✓  ${labels[i]}: ${r.value.length} AI items`); });
  return unique;
}

app.get("/feed", async (req, res) => {
  try {
    const now = Date.now();
    if (now - CACHE.lastFetch < CACHE_TTL && CACHE.items.length > 0) {
      return res.json({ items: CACHE.items, cached: true, age: Math.round((now-CACHE.lastFetch)/1000) });
    }
    CACHE.items = await fetchAll();
    CACHE.lastFetch = Date.now();
    res.json({ items: CACHE.items, cached: false, age: 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/health", (_, res) => res.json({ ok: true, items: CACHE.items.length, lastFetch: CACHE.lastFetch }));

app.listen(PORT, () => {
  console.log(`\n🚀 Pulse backend running at http://localhost:${PORT}\n`);
  fetchAll().then(items => { CACHE.items = items; CACHE.lastFetch = Date.now(); console.log(`✅ Cache warm — ${items.length} items loaded\n`); });
});
