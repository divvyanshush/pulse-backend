import express from "express";
import { createClient } from "@supabase/supabase-js";
import { Resend } from "resend";
import cors from "cors";
import fetch from "node-fetch";
import Parser from "rss-parser";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app    = express();
const parser = new Parser({ timeout: 10000, headers: { "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, */*" } });
const PORT   = 3001;

app.use(cors({ origin: "*" }));
app.use(express.json());

// ── RATE LIMITER ─────────────────────────────────────────────────
const rateLimitMap = new Map();
const rateLimit = (key, maxReqs, windowMs) => {
  const now = Date.now();
  const record = rateLimitMap.get(key) || { count: 0, start: now };
  if(now - record.start > windowMs) {
    rateLimitMap.set(key, { count: 1, start: now });
    return false;
  }
  record.count++;
  rateLimitMap.set(key, record);
  return record.count > maxReqs;
};

const CACHE = { items: [], lastFetch: 0 };
const CACHE_TTL = 14 * 60 * 1000; // 14 min — just under auto-refresh interval

// ── Bookmarks storage ─────────────────────────────────────────────
const BOOKMARKS_FILE = path.join(__dirname, "bookmarks.json");
function loadBookmarks() {
  try {
    if (fs.existsSync(BOOKMARKS_FILE)) {
      return JSON.parse(fs.readFileSync(BOOKMARKS_FILE, "utf8"));
    }
  } catch(e) { console.warn("Could not load bookmarks:", e.message); }
  return {};
}
function saveBookmarks(bm) {
  try { fs.writeFileSync(BOOKMARKS_FILE, JSON.stringify(bm, null, 2)); }
  catch(e) { console.warn("Could not save bookmarks:", e.message); }
}
let BOOKMARKS = loadBookmarks(); // { [itemId]: itemObject }

// ── AI keyword filter ─────────────────────────────────────────────
const AI_KW = [
  "llm","gpt","claude","gemini","openai","anthropic","mistral","llama","grok",
  "deepseek","qwen","phi-","falcon","bloom","palm","bard","copilot","chatgpt",
  "deepmind","openai","hugging face","huggingface","nvidia","groq","perplexity",
  "midjourney","sora","runway","stability","cohere","xai","inflection","adept",
  "artificial intelligence"," ai ","ai-","machine learning","deep learning",
  "neural network","transformer","diffusion","embedding","inference","fine-tun",
  "rlhf","rag","retrieval","vector","multimodal","foundation model","language model",
  "generative ai","computer vision","nlp","natural language","reinforcement learning",
  "alignment","hallucin","benchmark","dataset","parameter","token","attention",
  "latent","autoregressive","quantiz","distillation","lora","prompt","agent",
  "cursor","replit","github copilot","tabnine","codewhisperer","devin","bolt",
  "v0 ","lovable","vercel ai","langchain","llamaindex","autogpt","babyagi",
  "stable diffusion","dall-e","dall·e","imagen","firefly","whisper","elevenlabs",
  "agi","superintelligence","ai safety","ai regulation","ai policy","ai ethics",
  "ai startup","ai funding","ai research","ai model","ai tool","ai agent",
  "ai generated","ai powered","ai based","ai driven","large model","small model",
  "open source model","open weight","model release","model launch",
];
const isAI = t => { const s=(t||"").toLowerCase(); return AI_KW.some(k=>s.includes(k)); };

const guessType = (t, body="", src="") => {
  const s = ((t||"")+" "+(body||"")).toLowerCase();
  const title = (t||"").toLowerCase();

  // Source-based — most reliable signal
  if(src==="GitHub") return "repo";
  if(src==="HN" || src==="Lobste.rs" || src==="LessWrong" || src==="AlignmentForum") return "discuss";
  if(src==="arXiv") return "research";

  // Funding — very specific signals only
  if (/series [abcde] |seed round|funding round|\$\d+[mb] raise|acqui[a-z]+ |merger|ipo/.test(s)) return "funding";

  // Model — specific model names anywhere in title
  if (/\bgpt-[\d.]|claude [\d]|claude opus|claude sonnet|claude haiku|gemini [\d.]|llama [\d]|llama-[\d]|mistral [\d]|deepseek-|deepseek [\d]|qwen[\d]|phi-[\d]|grok-[\d]|gpt-4|gpt-5|o1 |o3 |o1-|o3-/.test(title)) return "model";
  if (/\b(releases?|launches?|ships?|announces?|introduces?)\b.{0,30}\b(model|api|weights?)\b/.test(title)) return "model";
  if (/open.?source[sd]?|open weight|model card|now available|available now/.test(title)) return "model";

  // Research — academic signals in title only (not body — too noisy)
  if (/\bpaper\b|\bsurvey\b|\bpreprint\b|\bbenchmark\b/.test(title)) return "research";
  if (/: a .{3,30} (approach|method|framework|system|model)$/i.test(t||"")) return "research";

  // Policy
  if (/regulation|eu ai act|senate|congress|executive order|copyright law|lawsuit|sued/.test(title)) return "policy";

  // Drama
  if (/fired|resign|scandal|layoff|laid off/.test(title)) return "drama";

  return "tool";
};


const guessTags = (t, body="") => {
  const s = ((t||"")+" "+(body||"")).toLowerCase();
  const tags = [];
  // Frameworks & tools
  if (/rag|retrieval.augmented|retrieval augmented/.test(s)) tags.push("RAG");
  if (/agent[s]?|agentic|multi.agent|autonomous agent/.test(s)) tags.push("Agents");
  if (/llm[s]?|large language model/.test(s)) tags.push("LLM");
  if (/fine.tun|finetuning|finetune|lora|qlora|peft/.test(s)) tags.push("Fine-tuning");
  if (/diffusion|stable diffusion|image gen|text.to.image|dall.e|midjourney|flux/.test(s)) tags.push("Diffusion");
  if (/multimodal|multi.modal|vision.language|vlm|image.text|text.image/.test(s)) tags.push("Multimodal");
  if (/transformer[s]?|attention mechanism|self.attention/.test(s)) tags.push("Transformer");
  if (/rlhf|reinforcement learning from|reward model|ppo|grpo/.test(s)) tags.push("RLHF");
  if (/vector.db|vector database|embedding[s]?|semantic search|pinecone|weaviate|chroma/.test(s)) tags.push("Embeddings");
  if (/langchain|llamaindex|llama.index|haystack/.test(s)) tags.push("LangChain");
  if (/open.?source|open weight|open model/.test(s)) tags.push("Open Source");
  if (/benchmark[s]?|leaderboard|eval[s]?|mmlu|hellaswag|gsm8k/.test(s)) tags.push("Benchmark");
  if (/reasoning|chain.of.thought|cot|o1|r1|thinking model/.test(s)) tags.push("Reasoning");
  if (/code.gen|coding model|code model|copilot|devin|swe.bench/.test(s)) tags.push("Code");
  if (/safety|alignment|jailbreak|red.team|guardrail|bias|harmless/.test(s)) tags.push("Safety");
  return tags.slice(0, 3); // max 3 tags per item
};

// Source credibility weights — how much we trust each source
const SRC_WEIGHT = {
  // Tier 1 — must-read for AI builders
  Karpathy: 1.4, LilianWeng: 1.3, SimonW: 1.25,
  Anthropic: 1.2, OpenAI: 1.2, Mistral: 1.15,
  DeepMind: 1.15, GoogleResearch: 1.1, MetaAI: 1.05,
  Raschka: 1.05, Interconnects: 1.0, DeepLearningAI: 1.0,
  // Tier 2 — strong community signals
  HN: 1.0, "Lobste.rs": 0.95, LessWrong: 0.9, AlignmentForum: 0.9,
  HuggingFace: 1.0, LangChain: 0.95, LlamaIndex: 0.95,
  WandB: 0.95, FastAI: 0.95, TogetherAI: 0.92, Cohere: 0.92,
  arXiv: 0.88, GitHub: 0.88, ImportAI: 1.05, TheSequence: 0.92,
  // Tier 3 — useful but lower signal
  Microsoft: 0.82, MITReview: 0.82, "Dev.to": 0.78,
  TDS: 0.75, MarkTechPost: 0.72,
  // Tier 4 — general tech media
  TechCrunch: 0.68, TheVerge: 0.65, VentureBeat: 0.65,
  Wired: 0.62,
};

// Developer relevance keywords — boost items that matter to builders
const DEV_KEYWORDS = [
  "open.source","released","launches","api","benchmark","outperforms",
  "fine.tun","training","inference","deploy","model","dataset","paper",
  "research","agent","rag","embedding","llm","gpt","claude","gemini",
  "mistral","llama","open.weights","arxiv","github","repo"
];

const heatScore = (score, comments, src, time, title="", sum="") => {
  const text = (title + " " + sum).toLowerCase();

  // Base engagement score per source
  const rawEngagement =
      src==="HN"        ? Math.min(score/3, 60)  + Math.min((comments||0)/2, 30)
    : src==="Dev.to"    ? Math.min(score/1.5, 55) + Math.min((comments||0)/2, 25)
    : src==="GitHub"    ? Math.min(score/4, 70)   + Math.min((comments||0)/2, 25)
    : src==="Lobste.rs" ? Math.min(score/2, 50)   + Math.min((comments||0)/2, 25)
    : src==="arXiv"     ? 38
    : src==="OpenAI" || src==="Anthropic" ? 72
    : src==="GoogleResearch" || src==="MetaAI" || src==="HuggingFace" ? 62
    : src==="MITReview" || src==="Interconnects" || src==="SimonW" ? 52
    : src==="TechCrunch" || src==="TheVerge" || src==="VentureBeat" ? 48
    : 40;

  // Source credibility multiplier
  const credibility = SRC_WEIGHT[src] || 0.65;

  // Developer relevance boost — up to +15 points
  const devMatches = DEV_KEYWORDS.filter(kw => text.includes(kw.replace(".","")||kw)).length;
  const devBoost = Math.min(devMatches * 3, 15);

  // GitHub star velocity boost
  const starBoost = src==="GitHub" && score > 1000 ? Math.min((score-1000)/150, 25) : 0;

  const engagement = (rawEngagement * credibility) + devBoost + starBoost;

  // Time decay — items lose heat after 6 hours, heavily after 24h
  const ageHours = time ? (Date.now()/1000 - time) / 3600 : 0;
  const decay = ageHours < 2  ? 1.0
              : ageHours < 6  ? 0.92
              : ageHours < 12 ? 0.78
              : ageHours < 24 ? 0.58
              : ageHours < 48 ? 0.38
              : 0.2;

  return Math.min(Math.round(engagement * decay), 99);
};

const safeText = t => (t||"").replace(/<[^>]+>/g,"").replace(/\s+/g," ").trim();

// ── FETCHERS ──────────────────────────────────────────────────────

async function fetchHN() {
  // Fetch top, ask, and show stories in parallel
  const [topRes, askRes, showRes] = await Promise.allSettled([
    fetch("https://hacker-news.firebaseio.com/v0/topstories.json", {signal:AbortSignal.timeout(10000)}).then(r=>r.json()),
    fetch("https://hacker-news.firebaseio.com/v0/askstories.json", {signal:AbortSignal.timeout(10000)}).then(r=>r.json()),
    fetch("https://hacker-news.firebaseio.com/v0/showstories.json", {signal:AbortSignal.timeout(10000)}).then(r=>r.json()),
  ]);

  const topIds = topRes.status==="fulfilled" ? topRes.value.slice(0,200) : [];
  const askIds = askRes.status==="fulfilled" ? askRes.value.slice(0,50) : [];
  const showIds = showRes.status==="fulfilled" ? showRes.value.slice(0,50) : [];

  const seen = new Set();
  const allIds = [...topIds, ...askIds, ...showIds].filter(id => {
    if(seen.has(id)) return false;
    seen.add(id);
    return true;
  });

  const rows = await Promise.allSettled(allIds.map(id =>
    fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`, {signal:AbortSignal.timeout(6000)}).then(r=>r.json())
  ));
  return rows
    .filter(r => r.status==="fulfilled" && r.value?.title && isAI(r.value.title+(r.value.text||"")))
    .map(({value:s}) => ({
      id:`hn-${s.id}`, src:"HN", type:"discuss", tags:guessTags(s.title), title:s.title,
      sum: s.text ? safeText(s.text).slice(0,220)+"…" : "Discussion on Hacker News.",
      link: s.url||`https://news.ycombinator.com/item?id=${s.id}`,
      time:s.time, score:s.score||0, comments:s.descendants||0,
    }));
}

const ARXIV_RELEVANCE = (title, summary="") => {
  const s = (title + " " + summary).toLowerCase();
  let score = 0;
  const HIGH = [/\bllm\b/,/\blarge language model/,/\bagents?\b/,/\breasoning\b/,
    /fine.tun/,/\brlhf\b/,/\brag\b|retrieval.augmented/,/\binference\b/,
    /context.length|context window/,/\bmultimodal\b/,/\bembedding/,
    /\bvlm\b|vision.language/,/chain.of.thought/,/\bcode gen|code model/];
  const MED = [/\btransformer\b/,/\battention\b/,/\bdiffusion\b/,/\bbenchmark\b/,/\bevaluat/];
  const LABS = [/google|deepmind|openai|anthropic|meta |microsoft|mistral|hugging/];
  HIGH.forEach(r => { if(r.test(s)) score += 3; });
  MED.forEach(r => { if(r.test(s)) score += 1; });
  LABS.forEach(r => { if(r.test(s)) score += 2; });
  return score;
};

async function fetchArxiv() {
  const res = await fetch("https://export.arxiv.org/api/query?search_query=cat:cs.AI+OR+cat:cs.LG+OR+cat:cs.CL+OR+cat:cs.CV&sortBy=lastUpdatedDate&sortOrder=descending&max_results=60", {signal:AbortSignal.timeout(20000)});
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
    return { id:`arxiv-${link.split("/abs/")[1]||Math.random()}`, src:"arXiv", type:"research", tags:guessTags(title, summary), title, sum:summary, link, time, score:0, comments:0, authors };
  }).filter(e=>e.title);
}

async function fetchDevTo() {
  const [r1, r2] = await Promise.allSettled([
    fetch("https://dev.to/api/articles?tag=ai&per_page=30&top=1", {signal:AbortSignal.timeout(10000)}).then(r=>r.json()),
    fetch("https://dev.to/api/articles?tag=machinelearning&per_page=20&top=1", {signal:AbortSignal.timeout(10000)}).then(r=>r.json()),
  ]);
  const seen = new Set();
  const combined = [
    ...(r1.status==="fulfilled" ? r1.value : []),
    ...(r2.status==="fulfilled" ? r2.value : []),
  ].filter(a => {
    if(seen.has(a.id)) return false;
    seen.add(a.id);
    return true; // arXiv already filtered to AI categories
  });
  return combined.map(a=>({
    id:`devto-${a.id}`, src:"Dev.to", type:guessType(a.title), tags:guessTags(a.title), title:a.title,
    sum: safeText(a.description||"").slice(0,220)+"…",
    link:a.url, time:Math.floor(new Date(a.published_at).getTime()/1000),
    score:a.positive_reactions_count||0, comments:a.comments_count||0,
  }));
}

async function fetchLobsters() {
  const res = await fetch("https://lobste.rs/t/ai.json", {signal:AbortSignal.timeout(10000)});
  const json = await res.json();
  return (json||[]).map(s=>({
    id:`lobsters-${s.short_id}`, src:"Lobste.rs", type:"discuss", tags:guessTags(s.title), title:s.title,
    sum:`${s.description||"Technical discussion on Lobste.rs."}`.slice(0,220),
    link:s.url||`https://lobste.rs/s/${s.short_id}`,
    time:Math.floor(new Date(s.created_at).getTime()/1000),
    score:s.score||0, comments:s.comment_count||0,
  }));
}

async function fetchGitHub() {
  const queries = [
    "topic:llm+stars:%3E200",
    "topic:ai-agents+stars:%3E100",
    "topic:large-language-models+stars:%3E100",
    "topic:generative-ai+stars:%3E200",
    "topic:rag+stars:%3E100",
  ];

  const results = await Promise.allSettled(queries.map(q =>
    fetch(`https://api.github.com/search/repositories?q=${q}&sort=updated&order=desc&per_page=15`, {
      headers:{"Accept":"application/vnd.github.v3+json","User-Agent":"pulse-app/1.0"},
      signal:AbortSignal.timeout(10000)
    }).then(r=>r.json())
  ));

  const seen = new Set();
  const repos = [];
  for(const r of results) {
    if(r.status !== "fulfilled") continue;
    for(const repo of (r.value?.items||[])) {
      if(seen.has(repo.id)) continue;
      seen.add(repo.id);
      repos.push({
        id:`github-${repo.id}`, src:"GitHub", type:"repo",
        title:`${repo.full_name} — ${repo.description||""}`.slice(0,100),
        sum:(repo.description||"No description.").slice(0,220),
        link:repo.html_url,
        time:Math.floor(new Date(repo.pushed_at||repo.updated_at).getTime()/1000),
        score:repo.stargazers_count||0, comments:repo.forks_count||0,
      });
    }
  }
  return repos;
}

async function fetchRSS(url, src, srcLabel, aiOnly=false, customHeaders={}) {
  const feedParser = Object.keys(customHeaders).length > 0
    ? new Parser({ timeout:10000, headers:{ "Accept":"application/rss+xml, application/atom+xml, application/xml, text/xml, */*", ...customHeaders } })
    : parser;
  const feed = await feedParser.parseURL(url);
  return (feed.items||[]).slice(0, 20)
    .filter(e => aiOnly || isAI((e.title||"")+(e.contentSnippet||e.summary||"")))
    .map(e=>({
      id:`${src.toLowerCase().replace(/\s/g,"-")}-${Buffer.from(e.link||e.title||"").toString("base64").slice(0,32)}`,
      src, srcLabel:srcLabel||src, type:guessType(e.title||"", e.contentSnippet||e.summary||""), tags:guessTags(e.title||"", e.contentSnippet||e.summary||""),
      title:(e.title||"").replace(/\n/g," ").trim(),
      sum:safeText(e.contentSnippet||e.summary||e.content||"").slice(0,240)+"…",
      link:e.link||"", time:e.pubDate?Math.floor(new Date(e.pubDate).getTime()/1000):Math.floor(Date.now()/1000),
      score:0, comments:0, authors:e.creator||e.author||"",
    }));
}

const RSS_SOURCES = [
  { url:"https://openai.com/blog/rss.xml",                src:"OpenAI",      label:"OpenAI Blog",    aiOnly:true },
  { url:"https://deepmind.google/blog/feed/basic/", src:"DeepMind", label:"DeepMind Blog", aiOnly:true },
  { url:"https://huggingface.co/blog/feed.xml",           src:"HuggingFace", label:"HuggingFace Blog",aiOnly:true },
  { url:"https://venturebeat.com/category/ai/feed/",      src:"VentureBeat", label:"VentureBeat AI", aiOnly:true },
  { url:"https://techcrunch.com/category/artificial-intelligence/feed/", src:"TechCrunch", label:"TechCrunch AI", aiOnly:true },
  { url:"https://www.theverge.com/rss/ai-artificial-intelligence/index.xml", src:"TheVerge", label:"The Verge AI", aiOnly:true },
  { url:"https://www.wired.com/feed/tag/ai/latest/rss",   src:"Wired",       label:"Wired AI",       aiOnly:true },
  { url:"https://www.technologyreview.com/feed/",         src:"MITReview",   label:"MIT Tech Review", aiOnly:false },
  { url:"https://simonwillison.net/atom/everything/",     src:"SimonW",      label:"Simon Willison",  aiOnly:true },
  { url:"https://www.interconnects.ai/feed",              src:"Interconnects",label:"Interconnects",  aiOnly:true },
  { url:"https://blogs.microsoft.com/ai/feed/",           src:"Microsoft",   label:"Microsoft AI",    aiOnly:true },
  { url:"https://towardsdatascience.com/feed",            src:"TDS",         label:"Towards Data Science", aiOnly:false },
  { url:"https://www.marktechpost.com/feed/",             src:"MarkTechPost", label:"MarkTechPost",   aiOnly:true },
  { url:"https://bdtechtalks.com/feed/",                  src:"TechTalks",   label:"BD Tech Talks",   aiOnly:false },
  { url:"https://thesequence.substack.com/feed",          src:"TheSequence", label:"The Sequence",    aiOnly:true },
  { url:"https://lastweekin.ai/feed",                     src:"LastWeekInAI",label:"Last Week in AI", aiOnly:true },
  { url:"https://importai.substack.com/feed",             src:"ImportAI",    label:"Import AI",       aiOnly:true },
  { url:"https://www.together.ai/blog/rss.xml", src:"TogetherAI", label:"Together AI", aiOnly:true },
  { url:"https://wandb.ai/fully-connected/rss.xml", src:"WandB", label:"Weights & Biases", aiOnly:true },
  { url:"https://magazine.sebastianraschka.com/feed", src:"Raschka", label:"Sebastian Raschka", aiOnly:true },
  { url:"https://lilianweng.github.io/index.xml", src:"LilianWeng", label:"Lilian Weng", aiOnly:true },
  { url:"https://blog.langchain.dev/rss/", src:"LangChain", label:"LangChain Blog", aiOnly:true },
  { url:"https://www.lesswrong.com/feed.xml", src:"LessWrong", label:"LessWrong", aiOnly:false },
  { url:"https://alignmentforum.org/feed.xml", src:"AlignmentForum", label:"Alignment Forum", aiOnly:false },
];


// ── Topic clustering — deduplicate same-story coverage ────────────
function clusterItems(items) {
  const STOP = new Set([
    "the","a","an","in","of","to","for","and","or","with","on","at","by",
    "how","what","why","when","new","ai","using","use","your","from","its",
    "this","that","are","is","was","we","our","can","get","will","has",
    "have","about","into","more","based","via","vs","model","models","llm",
    "large","language","learning","deep","machine","neural","data","paper",
    "build","building","make","making","system","systems","open","source","free","local","tool","tools","show","built","agent","agents","code","based"
  ]);

  const getKeywords = (title) => {
    return title.toLowerCase()
      .replace(/[^a-z0-9 ]/g," ")
      .split(/\s+/)
      .filter(w => w.length > 3 && !STOP.has(w));
  };

  const clustered = [];
  const used = new Set();

  // Sort by heat descending — lead item is always highest heat
  const sorted = [...items].sort((a,b) => (b.heat||0) - (a.heat||0));

  for(const item of sorted) {
    if(used.has(item.id)) continue;
    const kw = new Set(getKeywords(item.title || ""));
    if(kw.size === 0) { clustered.push(item); used.add(item.id); continue; }

    const related = [];
    // Don't cluster GitHub repos with each other
    if(item.src === "GitHub") {
      clustered.push({ ...item, relatedCount: 0 });
      used.add(item.id);
      continue;
    }
    for(const other of sorted) {
      if(used.has(other.id) || other.id === item.id) continue;
      // Don't pull GitHub repos into news clusters
      if(other.src === "GitHub") continue;
      const okw = getKeywords(other.title || "");
      const overlap = okw.filter(w => kw.has(w)).length;
      const timeDiff = Math.abs((item.time||0) - (other.time||0));
      // HN/Lobsters need higher overlap threshold — titles are short and noisy
      const threshold = (item.src==="HN"||item.src==="Lobste.rs"||other.src==="HN"||other.src==="Lobste.rs") ? 3 : 2;
      if(overlap >= threshold && timeDiff < 172800) {
        related.push({ id:other.id, title:other.title, src:other.src, link:other.link, heat:other.heat });
        used.add(other.id);
      }
    }

    clustered.push({
      ...item,
      related: related.length > 0 ? related : undefined,
      relatedCount: related.length
    });
    used.add(item.id);
  }

  return clustered;
}

// ── Main aggregator ────────────────────────────────────────────────
async function fetchAll() {
  console.log("🔄 Fetching all sources…");
  const results = await Promise.allSettled([
    fetchHN(), fetchArxiv(), fetchDevTo(),
    fetchLobsters(), fetchGitHub(),
    ...RSS_SOURCES.map(s => fetchRSS(s.url, s.src, s.label, s.aiOnly, s.headers||{})),
  ]);
  const labels = ["HN","arXiv","Dev.to","Lobste.rs","GitHub",...RSS_SOURCES.map(s=>s.label)];
  const items = results
    .filter(r => r.status==="fulfilled")
    .flatMap(r => r.value)
    .map(i => ({ ...i, heat: heatScore(i.score, i.comments, i.src, i.time, i.title||"", i.sum||"") }));
  results.forEach((r,i) => {
    if(r.status==="rejected") console.warn(`⚠  ${labels[i]} failed:`, r.reason?.message);
    else console.log(`✓  ${labels[i]}: ${r.value.length} items`);
  });
  // Content filter — remove jailbreaks, prompt injections, spam
  const BLOCK_KEYWORDS = [
    "jailbreak","liberat","disregard prev","clear your mind","new instruct",
    "DISREGARD","PREV. INSTRUCT","liberation prompt","harmful prompt",
    "bypass","uncensor","DAN prompt","ignore previous"
  ];
  const filtered = items.filter(i => {
    const text = ((i.title||"")+" "+(i.sum||"")).toLowerCase();
    return !BLOCK_KEYWORDS.some(kw => text.includes(kw.toLowerCase()));
  });

  const seen = new Set();
  const titleSeen = new Set();
  const normalize = t => t.toLowerCase().replace(/[^a-z0-9]/g,"").slice(0,60);
  const unique = filtered.filter(i => {
    if(!i.title || seen.has(i.id)) return false;
    const tk = normalize(i.title);
    // Check for similar titles (first 60 normalized chars)
    if(titleSeen.has(tk)) return false;
    seen.add(i.id);
    titleSeen.add(tk);
    return true;
  });
  // Cap arXiv at top 25 by relevance score
  const arxivItems = unique.filter(i => i.src === "arXiv")
    .map(i => ({ ...i, _rel: ARXIV_RELEVANCE(i.title, i.sum) }))
    .sort((a,b) => b._rel - a._rel || b.time - a.time)
    .slice(0, 25);
  const nonArxiv = unique.filter(i => i.src !== "arXiv");
  const capped = [...nonArxiv, ...arxivItems];
  capped.sort((a,b) => b.time - a.time);
  const finalItems = capped;
  unique.length = 0;
  unique.push(...finalItems);
  unique.sort((a,b) => b.time - a.time);
  const clustered = clusterItems(unique);
  console.log(`✅ Total: ${clustered.length} items (clustered from ${unique.length})\n`);
  return clustered;
}

// ── Background "why this matters" generator ────────────────────
const WHY_CACHE = new Map();
let DIGEST_CACHE = { data: null, ts: 0 };
// Clear on each deploy to regenerate with new prompt

async function generateWhys(items) {
  // Only process top 30 by heat that don't have a why yet
  const top30 = [...items]
    .sort((a,b)=>(b.heat||0)-(a.heat||0))
    .filter(i => i.src !== "GitHub")
    .slice(0,30)
    .filter(i => !WHY_CACHE.has(i.id));

  if(!top30.length) return;

  try {
    const prompt = `You are a senior engineer writing a daily briefing for AI developers. For each item below, write ONE short sentence (max 10 words) that answers: "So what? Why does this matter to someone building AI products?" Focus on practical impact — cost, speed, capability, or workflow change. Never restate the title. Skip items that are not genuinely useful to developers (tutorials, listicles, spam) by returning an empty string for those.
Return ONLY a valid JSON object mapping id to sentence. Example: {"id1":"Cuts inference cost by 40% on consumer hardware.","id2":""}

Items:
${top30.map(i=>`{"id":"${i.id}","title":${JSON.stringify(i.title)},"sum":${JSON.stringify((i.sum||"").slice(0,120))}}`).join("\n")}`;

    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method:"POST",
      headers:{"Content-Type":"application/json","Authorization":"Bearer "+process.env.GROQ_API_KEY},
      body:JSON.stringify({
        model:"llama-3.1-8b-instant",
        messages:[{role:"user",content:prompt}],
        max_tokens:600,
        temperature:0.2
      })
    });
    const data = await res.json();
    const raw = data.choices?.[0]?.message?.content?.trim()||"{}";
    const clean = raw.replace(/```json|```/g,"").trim();
    let whys = {};
    try {
      const match = clean.match(/\{[\s\S]*\}/);
      if(match) whys = JSON.parse(match[0]);
    } catch(e2) {
      const lines = clean.split("\n");
      for(const line of lines) {
        const m = line.match(/"([^"]+)"\s*:\s*"([^"]*)"/);
        if(m) whys[m[1]] = m[2];
      }
    }
    Object.entries(whys).forEach(([id,why])=>{ if(why) WHY_CACHE.set(id,why); });
    console.log("Generated "+Object.keys(whys).length+" why-this-matters");
  } catch(e) {
    console.warn("Why generation failed:", e.message);
  }
}

// ── Routes ─────────────────────────────────────────────────────────

// Feed

// ── Daily Briefing ──────────────────────────────────────────────
// /briefing removed — use /digest
if(false) app.get("/briefing", async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");

  // Cache for 30 minutes
  if(BRIEFING_CACHE.data && Date.now() - BRIEFING_CACHE.ts < 15*60*1000) {
    return res.json(BRIEFING_CACHE.data);
  }

  try {
    const items = CACHE.items || [];
    const now = Math.floor(Date.now()/1000);

    // Briefing only shows real news/papers/blogs — not repos or HN discussions
    const NEWS_SOURCES = [
      "OpenAI","Anthropic","DeepMind","GoogleResearch","MetaAI","HuggingFace",
      "Microsoft","TechCrunch","TheVerge","VentureBeat","MITReview","Wired",
      "Interconnects","SimonW","ImportAI","TheSequence","LastWeekInAI",
      "TDS","MarkTechPost","TechTalks","AINnews","arXiv","Dev.to","Mistral","Raschka","LilianWeng","Karpathy","FastAI","DeepLearningAI","LangChain","Cohere","WandB","TogetherAI"
    ];
    const last48h = items.filter(i => now - (i.time||0) < 172800);
    const AI_RELEVANT = /ai|llm|gpt|claude|gemini|llama|mistral|model|neural|machine learning|deep learning|transformer|agent|inference|training|dataset|benchmark|openai|anthropic|deepmind|hugging/i;
    const newsOnly = last48h.filter(i => NEWS_SOURCES.includes(i.src) && AI_RELEVANT.test(i.title));
    // Enforce diversity — max 3 arXiv, max 4 of any single source
    const sorted = [...newsOnly].sort((a,b)=>(b.heat||0)-(a.heat||0));
    const srcCount = {};
    const top10 = [];
    for(const item of sorted) {
      if(top10.length >= 10) break;
      const src = item.src;
      srcCount[src] = (srcCount[src]||0) + 1;
      const maxForSrc = src==="arXiv" ? 3 : 4;
      if(srcCount[src] > maxForSrc) continue;
      top10.push(item);
    }

    if(!top10.length) return res.json({ items: [] });

    // Generate "why this matters" for each via Groq
    const prompt = `You are a principal engineer at a top AI lab. You read everything and cut through hype.
Below are today's top AI signals. For each, write ONE punchy sentence (15-25 words) that tells an AI builder exactly why they should care.

Rules:
- Be concrete and specific — mention the actual impact, number, or capability
- Speak to builders: "this means you can now...", "replaces X", "affects how you..."
- No fluff like "groundbreaking" or "revolutionary"
- If it's a paper, mention the key finding
- If it's a model release, mention what changed vs before
- If it's a tool, mention what problem it solves

Items:
${top10.map((i,idx)=>String(idx+1)+". ["+((i.type||"").toUpperCase())+"] "+i.title+"\n   "+((i.sum||"").slice(0,150))).join("\n\n")}

Return ONLY a JSON array of 10 strings. No markdown, no explanation.
Format: ["sentence1","sentence2",...]`;

    const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 600,
        temperature: 0.4
      })
    });

    const groqData = await groqRes.json();
    const raw = groqData.choices?.[0]?.message?.content?.trim() || "[]";
    let whys = [];
    try {
      const clean = raw.replace(/```json|```/g,"").trim();
      whys = JSON.parse(clean);
    } catch(e) { whys = top10.map(()=>""); }

    const briefing = {
      date: new Date().toLocaleDateString("en-US",{month:"long",day:"numeric",year:"numeric"}).toUpperCase(),
      items: top10.map((item,i) => ({
        idx: i+1,
        type: item.type,
        title: item.title,
        why: whys[i] || "",
        src: item.src,
        heat: item.heat,
        link: item.link,
        id: item.id
      }))
    };

    BRIEFING_CACHE = { data: briefing, ts: Date.now() };
    res.json(briefing);
  } catch(e) {
    console.error("Briefing error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get("/feed", async (req, res) => {
  try {
    const now = Date.now();
    if (now - CACHE.lastFetch < CACHE_TTL && CACHE.items.length > 0) {
      return res.json({ items: CACHE.items, cached: true, age: Math.round((now-CACHE.lastFetch)/1000) });
    }
    const fetched = await fetchAll();
    CACHE.items = fetched;
    CACHE.lastFetch = Date.now();
    DIGEST_CACHE = { data: null, ts: 0 }; // invalidate digest when feed refreshes
    res.json({ items: CACHE.items, cached: false, age: 0 });
  } catch(err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Health
app.get("/health", (_, res) => res.json({ ok:true, items:CACHE.items.length, lastFetch:CACHE.lastFetch }));

// Force cache refresh
app.get("/refresh", async (req, res) => {
  try {
    console.log("🔄 Manual refresh triggered");
    CACHE.items = [];
    CACHE.lastFetch = 0;
    DIGEST_CACHE = { data: null, ts: 0 };
    const items = await fetchAll();
    CACHE.items = items;
    CACHE.lastFetch = Date.now();
    res.json({ ok: true, items: items.length });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── AI SUMMARY ────────────────────────────────────────────────────
// POST /summarize  { title, sum, src, type }
// Returns { summary: "…" }
app.post("/summarize", async (req, res) => {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.remoteAddress || "unknown";
  if(rateLimit(`summarize:${ip}`, 20, 60_000)) return res.status(429).json({ error: "Too many requests. Please slow down." });
  const { title, sum, src, type } = req.body || {};
  if (!title) return res.status(400).json({ error: "title required" });

  const GROQ_API_KEY = process.env.GROQ_API_KEY;
  if (!GROQ_API_KEY) return res.status(500).json({ error: "GROQ_API_KEY not set" });

  try {
    const prompt = `You are a staff engineer who reads everything in AI. Be direct and technical.

Article:
Title: ${title}
Source: ${src || "unknown"}
Type: ${type || "unknown"}
Summary: ${sum || "N/A"}

Write 2-3 sentences for an AI builder audience:
- Sentence 1: What exactly happened or what was found (be specific with numbers/names if relevant)
- Sentence 2: What this means practically — what can you do now, what changes, what to watch
- Sentence 3 (optional): Any gotcha, limitation, or context worth knowing

Rules: no hype words, no "groundbreaking/revolutionary/exciting", be concrete, write like you're slacking a colleague.

Reply with ONLY the summary, no preamble, no bullet points.`;

    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        max_tokens: 250,
        temperature: 0.3,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: AbortSignal.timeout(20000),
    });

    if (!response.ok) {
      const err = await response.text();
      return res.status(502).json({ error: `Groq API error: ${err}` });
    }

    const data = await response.json();
    const summary = data.choices?.[0]?.message?.content?.trim() || "Could not generate summary.";
    res.json({ summary });
  } catch(e) {
    console.error("Summarize error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── BOOKMARKS ─────────────────────────────────────────────────────
// GET  /bookmarks          → { bookmarks: [item, …] }
app.get("/bookmarks", (req, res) => {
  res.json({ bookmarks: Object.values(BOOKMARKS) });
});

// POST /bookmarks          { item }  → saves item
app.post("/bookmarks", (req, res) => {
  const { item } = req.body || {};
  if (!item?.id) return res.status(400).json({ error: "item.id required" });
  BOOKMARKS[item.id] = { ...item, bookmarkedAt: Date.now() };
  saveBookmarks(BOOKMARKS);
  res.json({ ok: true, id: item.id });
});

// DELETE /bookmarks/:id   → removes bookmark
app.delete("/bookmarks/:id", (req, res) => {
  const id = decodeURIComponent(req.params.id);
  if (!BOOKMARKS[id]) return res.status(404).json({ error: "not found" });
  delete BOOKMARKS[id];
  saveBookmarks(BOOKMARKS);
  res.json({ ok: true, id });
});

// ── Auto-refresh cache ─────────────────────────────────────────────
setInterval(async () => {
  try {
    console.log("🔄 Auto-refreshing cache…");
    const newItems = await fetchAll();
    if(newItems && newItems.length > 0) {
      CACHE.items = newItems;
      CACHE.lastFetch = Date.now();
      DIGEST_CACHE = { data: null, ts: 0 }; // invalidate digest on auto-refresh
      console.log(`✅ Cache refreshed — ${CACHE.items.length} items`);
    } else {
      console.log("⚠️ fetchAll returned empty — keeping existing cache");
    }
  } catch(e) {
    console.error("Auto-refresh failed:", e.message);
  }
}, 15 * 60 * 1000);


// ── TRENDING REPOS ─────────────────────────────────────────────
let trendingCache = { data: [], ts: 0 };

async function fetchTrendingRepos() {
  try {
    // Search for AI repos updated in last 24h, sorted by stars
    const since = new Date(Date.now() - 24*60*60*1000).toISOString().split('T')[0];
    const queries = [
      "topic:llm+pushed:>" + since,
      "topic:ai-agents+pushed:>" + since,
      "topic:machine-learning+pushed:>" + since,
    ];

    const results = await Promise.allSettled(queries.map(q =>
      fetch(`https://api.github.com/search/repositories?q=${q}&sort=stars&order=desc&per_page=10`, {
        headers:{"Accept":"application/vnd.github.v3+json","User-Agent":"pulse-app/1.0"},
        signal:AbortSignal.timeout(10000)
      }).then(r=>r.json())
    ));

    const seen = new Set();
    const repos = [];

    for(const r of results) {
      if(r.status !== "fulfilled") continue;
      for(const repo of (r.value?.items||[])) {
        if(seen.has(repo.id)) continue;
        seen.add(repo.id);
        repos.push({
          id: repo.id,
          name: repo.full_name,
          description: (repo.description||"").slice(0,100),
          stars: repo.stargazers_count||0,
          forks: repo.forks_count||0,
          url: repo.html_url,
          language: repo.language||"",
          topics: (repo.topics||[]).slice(0,3),
          updatedAt: repo.updated_at,
        });
      }
    }

    // Sort by stars, take top 10
    repos.sort((a,b) => b.stars - a.stars);
    return repos.slice(0, 10);
  } catch(e) {
    console.warn("fetchTrendingRepos failed:", e.message);
    return [];
  }
}

app.get("/trending-repos", async (req, res) => {
  try {
    const now = Date.now();
    if(now - trendingCache.ts < 10*60*1000 && trendingCache.data.length > 0) {
      return res.json({ repos: trendingCache.data });
    }
    const repos = await fetchTrendingRepos();
    trendingCache = { data: repos, ts: now };
    res.json({ repos });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});



// ── GET /digest — category summaries ─────────────────────────────
app.get("/digest", async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  if(DIGEST_CACHE.data && Date.now() - DIGEST_CACHE.ts < 10*60*1000) {
    return res.json(DIGEST_CACHE.data);
  }
  try {
    const items = CACHE.items || [];
    const now = Math.floor(Date.now()/1000);
    const recent = items.filter(i => now - (i.time||0) < 86400);

    const normalize = type => {
      if(type==="product") return "tool";
      if(type==="repo") return "repo";
      if(type==="discuss") return "discuss";
      return type || "tool";
    };

    const CATS = [
      { id:"model",    label:"Models & Releases" },
      { id:"research", label:"Research & Papers"  },
      { id:"tool",     label:"Tools & Libraries"  },
      { id:"discuss",  label:"Community"           },
      { id:"funding",  label:"Funding & Business"  },
    ];

    const grouped = {};
    for(const item of recent) {
      const key = normalize(item.type);
      if(!grouped[key]) grouped[key] = [];
      grouped[key].push(item);
    }
    for(const key of Object.keys(grouped)) {
      grouped[key].sort((a,b)=>(b.heat||0)-(a.heat||0));
    }

    const categoryPromises = CATS.map(async (cat) => {
      const catItems = (grouped[cat.id] || []).slice(0,15);
      if(catItems.length < 2) return null;
      const topItems = catItems.slice(0,8);
      const prompt = `You are a staff engineer giving a 30-second briefing on today's ${cat.label}.

Items:
${topItems.map((i,idx) => `${idx+1}. ${i.title}${i.sum ? " — " + i.sum.slice(0,100) : ""}`).join("\n")}

Rules:
- Name specific projects, models, or papers — no vague references
- Say what actually happened, not "there is a trend of..."
- Tell builders one concrete thing to do or watch
- Max 2 sentences
- No hype words: revolutionary, groundbreaking, exciting, significant

Reply with ONLY the 2-sentence summary.`;
      try {
        const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method:"POST",
          headers:{"Content-Type":"application/json","Authorization":`Bearer ${process.env.GROQ_API_KEY}`},
          body:JSON.stringify({model:"llama-3.3-70b-versatile",messages:[{role:"user",content:prompt}],max_tokens:150,temperature:0.3}),
          signal:AbortSignal.timeout(15000)
        });
        const d = await r.json();
        const summary = d.choices?.[0]?.message?.content?.trim() || "";
        return { id:cat.id, label:cat.label, summary, count:catItems.length,
          items:catItems.map(i=>({id:i.id,title:i.title,src:i.src,srcLabel:i.srcLabel,type:i.type,
            heat:i.heat,time:i.time,timeLabel:i.timeLabel,link:i.link,sum:i.sum,
            score:i.score,comments:i.comments,authors:i.authors||""})) };
      } catch(e) {
        return { id:cat.id, label:cat.label, summary:"", count:catItems.length,
          items:catItems.map(i=>({id:i.id,title:i.title,src:i.src,srcLabel:i.srcLabel,type:i.type,
            heat:i.heat,time:i.time,timeLabel:i.timeLabel,link:i.link,sum:i.sum,
            score:i.score,comments:i.comments,authors:i.authors||""})) };
      }
    });

    const categories = (await Promise.all(categoryPromises)).filter(Boolean);
    const digest = { categories, generatedAt: new Date().toISOString(), feedAge: Math.round((Date.now() - CACHE.lastFetch)/1000) };
    DIGEST_CACHE = { data:digest, ts:Date.now() };
    res.json(digest);
  } catch(e) {
    console.error("Digest error:", e);
    res.status(500).json({ error: e.message });
  }
});

// ── EMAIL DIGEST ───────────────────────────────────────────────


const resend = new Resend(process.env.RESEND_API_KEY);

app.post("/send-digest", async (req, res) => {
  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const { data: users } = await supabase.auth.admin.listUsers();
    const eligibleUsers = (users?.users || []).filter(u => u.email);
    if(!eligibleUsers.length) return res.json({ ok: true, sent: 0 });

    const digestRes = await fetch(`http://localhost:${PORT}/digest`);
    const digest = await digestRes.json();
    const allItems = (digest.categories || []).flatMap(c => c.items || []);
    const byType = {};
    for(const item of allItems) {
      const t = item.type || 'other';
      if(!byType[t]) byType[t] = [];
      if(byType[t].length < 2) byType[t].push(item);
    }
    const picked = Object.values(byType).flat();
    const pickedIds = new Set(picked.map(i => i.id));
    const rest = allItems.filter(i => !pickedIds.has(i.id));
    const top = [...picked, ...rest].slice(0, 8);
    if(!top.length) return res.json({ ok: true, sent: 0 });

    const rows = top.map(item => {
      const color = typeColors[item.type] || "#8b5cf6";
      return `<div style="padding:20px 0;border-bottom:1px solid #f0f0f0;"><span style="font-size:10px;padding:2px 8px;border-radius:3px;background:${color}18;color:${color};border:1px solid ${color}33;font-weight:700;letter-spacing:0.08em;">${(item.type||"").toUpperCase()}</span><br/><a href="${item.link}" style="color:#141414;text-decoration:none;font-size:15px;font-weight:600;line-height:1.5;display:block;margin:8px 0;">${item.title}</a><p style="color:#666;font-size:13px;line-height:1.6;margin:0;">${(item.sum||"").slice(0,200)}</p></div>`;
    }).join("");

    const today = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    const typeColors = { model:"#6366f1", research:"#3b82f6", funding:"#f59e0b", tool:"#8b5cf6", policy:"#ef4444", discuss:"#6b7280", repo:"#10b981", drama:"#f97316" };
    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"/></head><body style="margin:0;padding:0;background:#f5f5f5;font-family:'Helvetica Neue',Arial,sans-serif;"><div style="max-width:600px;margin:0 auto;background:#ffffff;"><div style="padding:32px 32px 24px;border-bottom:1px solid #ebebeb;"><div style="font-size:18px;font-weight:700;color:#141414;letter-spacing:0.15em;">COBUN AI</div><div style="font-size:12px;color:#888;margin-top:4px;">Today's AI signals — ${today}</div></div><div style="padding:8px 32px 24px;">${rows}</div><div style="padding:24px 32px;border-top:1px solid #ebebeb;text-align:center;background:#fafafa;"><a href="https://cobunai.com" style="display:inline-block;padding:10px 28px;background:#141414;color:#ffffff;font-size:12px;font-weight:600;text-decoration:none;border-radius:4px;letter-spacing:0.05em;">Open Cobun AI</a><p style="margin-top:16px;font-size:10px;color:#aaa;">You are receiving this as a Cobun AI user.</p></div></div></body></html>`;

    let sent = 0;
    for(const u of eligibleUsers) {
      const text = top.map(item => `${(item.type||'').toUpperCase()}: ${item.title}\n${item.link}`).join('\n\n') + '\n\nUnsubscribe: https://cobunai.com/app';
      await resend.emails.send({ from:"Cobun AI <digest@cobunai.com>", to:u.email, subject:`Cobun AI Daily — ${top.length} AI signals`, html: html + '<div style="text-align:center;margin-top:24px;"><a href="https://cobunai.com/app" style="font-size:10px;color:#444;text-decoration:underline;">Unsubscribe</a></div>', text });
      sent++;
    }
    res.json({ ok: true, sent });
  } catch(e) {
    console.error("send-digest error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── KEEP ALIVE (prevent Railway sleep) ─────────────────────────
const SELF_URL = process.env.RAILWAY_PUBLIC_DOMAIN 
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` 
  : null;

if(SELF_URL) {
  setInterval(async () => {
    try { await fetch(`${SELF_URL}/health`); } 
    catch(e) {}
  }, 4 * 60 * 1000); // ping every 4 minutes
}

// duplicate health endpoint removed

app.listen(PORT, () => {
  console.log(`\n🚀 Pulse backend — http://localhost:${PORT}\n`);
  fetchAll().then(async items => {
    CACHE.items=items.map(i=>({...i,why:""}));
    CACHE.lastFetch=Date.now();
    await generateWhys(items);
    CACHE.items=items.map(i=>({...i,why:WHY_CACHE.get(i.id)||""}));
    console.log("✅ Why cache applied to feed");
  });
});
