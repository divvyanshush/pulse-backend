import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import Parser from "rss-parser";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app    = express();
const parser = new Parser({ timeout: 10000 });
const PORT   = 3001;

app.use(cors({ origin: "*" }));
app.use(express.json());

const CACHE = { items: [], lastFetch: 0 };
const CACHE_TTL = 60_000;

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

const guessType = (t, body="") => {
  const s=((t||"")+" "+(body||"")).toLowerCase();
  // Research first — most specific signal
  if (/paper|arxiv|research|study|benchmark|dataset|findings|survey|experiment|we propose|we present|we introduce|novel approach|outperform|state.of.the.art|sota|ablation|evaluat|preprint/.test(s)) return "research";
  // Model — releases, launches
  if (/release|launch|released|launches|open.?source|open weight|weights|v\d[\.\d]|checkpoint|introduces|announc|new model|model card|available now|api access|now available|preview|beta|gpt-|claude |gemini |llama |mistral |deepseek |qwen |phi-|falcon |bloom |palm |grok /.test(s)) return "model";
  // Funding — money events
  if (/raise|raised|raises|funding|fund round|series [abcde]|seed round|valuation|billion|million|invest|backed|vc |venture|acqui|merger|ipo|spac/.test(s)) return "funding";
  // Policy — regulation, government
  if (/policy|regulation|regulate|eu |european union|senate|congress|parliament|law|legislat|govern|compli|legal|court|ruling|executive order|white house|biden|trump|act |bill |gdpr|copyright|privacy law/.test(s)) return "policy";
  // Drama — only if clearly about conflict (last resort)
  if (/resign|fired|lawsuit|sue |suing|drama|scandal|dispute|accus|fraud|investigation|layoff|lay off|laid off|cut jobs/.test(s)) return "drama";
  return "product";
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
  HN: 1.0, "Lobste.rs": 0.95,
  HuggingFace: 1.0, LangChain: 0.95, LlamaIndex: 0.95,
  WandB: 0.95, FastAI: 0.95, TogetherAI: 0.92, Cohere: 0.92,
  arXiv: 0.88, GitHub: 0.88, ImportAI: 0.88, TheSequence: 0.85,
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
  const res = await fetch("https://hacker-news.firebaseio.com/v0/topstories.json", {signal:AbortSignal.timeout(10000)});
  const ids = (await res.json()).slice(0, 200);
  const rows = await Promise.allSettled(ids.map(id =>
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

async function fetchArxiv() {
  const res = await fetch("https://export.arxiv.org/api/query?search_query=cat:cs.AI+OR+cat:cs.LG+OR+cat:cs.CL+OR+cat:cs.CV&sortBy=lastUpdatedDate&sortOrder=descending&max_results=80", {signal:AbortSignal.timeout(12000)});
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
  const res = await fetch("https://dev.to/api/articles?tag=ai&per_page=30&top=1", {signal:AbortSignal.timeout(10000)});
  const json = await res.json();
  return (json||[]).filter(a=>isAI(a.title+(a.description||""))).map(a=>({
    id:`devto-${a.id}`, src:"Dev.to", type:guessType(a.title), tags:guessTags(a.title), title:a.title,
    sum: safeText(a.description||"").slice(0,220)+"…",
    link:a.url, time:Math.floor(new Date(a.published_at).getTime()/1000),
    score:a.positive_reactions_count||0, comments:a.comments_count||0,
  }));
}

async function fetchDevToML() {
  const res = await fetch("https://dev.to/api/articles?tag=machinelearning&per_page=20&top=1", {signal:AbortSignal.timeout(10000)});
  const json = await res.json();
  return (json||[]).filter(a=>isAI(a.title+(a.description||""))).map(a=>({
    id:`devto-ml-${a.id}`, src:"Dev.to", type:guessType(a.title), tags:guessTags(a.title), title:a.title,
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
  const res = await fetch("https://api.github.com/search/repositories?q=topic:llm+stars:%3E500&sort=updated&order=desc&per_page=30", {
    headers:{"Accept":"application/vnd.github.v3+json","User-Agent":"pulse-app/1.0"},
    signal:AbortSignal.timeout(10000)
  });
  const json = await res.json();
  return (json?.items||[]).map(r=>({
    id:`github-${r.id}`, src:"GitHub", type:"repo", title:`${r.full_name} — ${r.description||""}`.slice(0,100),
    sum:(r.description||"No description.").slice(0,220),
    link:r.html_url, time:Math.floor(new Date(r.pushed_at||r.updated_at).getTime()/1000),
    score:r.stargazers_count||0, comments:r.forks_count||0,
  }));
}

async function fetchRSS(url, src, srcLabel, aiOnly=false) {
  const feed = await parser.parseURL(url);
  return (feed.items||[]).slice(0, 100)
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
  { url:"https://www.anthropic.com/rss.xml",              src:"Anthropic",   label:"Anthropic Blog", aiOnly:true },
  { url:"https://deepmind.google/discover/blog/rss/feed.xml", src:"DeepMind", label:"DeepMind Blog", aiOnly:true },
  { url:"https://huggingface.co/blog/feed.xml",           src:"HuggingFace", label:"HuggingFace Blog",aiOnly:true },
  { url:"https://venturebeat.com/category/ai/feed/",      src:"VentureBeat", label:"VentureBeat AI", aiOnly:true },
  { url:"https://techcrunch.com/category/artificial-intelligence/feed/", src:"TechCrunch", label:"TechCrunch AI", aiOnly:true },
  { url:"https://www.theverge.com/rss/ai-artificial-intelligence/index.xml", src:"TheVerge", label:"The Verge AI", aiOnly:true },
  { url:"https://www.wired.com/feed/tag/ai/latest/rss",   src:"Wired",       label:"Wired AI",       aiOnly:true },
  { url:"https://www.technologyreview.com/feed/",         src:"MITReview",   label:"MIT Tech Review", aiOnly:false },
  { url:"https://feed.infoq.com/",                        src:"InfoQ",       label:"InfoQ",           aiOnly:false },
  { url:"https://simonwillison.net/atom/everything/",     src:"SimonW",      label:"Simon Willison",  aiOnly:true },
  { url:"https://www.interconnects.ai/feed",              src:"Interconnects",label:"Interconnects",  aiOnly:true },
  { url:"https://artificialintelligence-news.com/feed/",  src:"AINnews",     label:"AI News",         aiOnly:true },
  { url:"https://blogs.microsoft.com/ai/feed/",           src:"Microsoft",   label:"Microsoft AI",    aiOnly:true },
  { url:"https://research.google/blog/rss/",              src:"GoogleResearch",label:"Google Research",aiOnly:true },
  { url:"https://meta.ai/blog/rss/",                      src:"MetaAI",      label:"Meta AI",         aiOnly:true },
  { url:"https://towardsdatascience.com/feed",            src:"TDS",         label:"Towards Data Science", aiOnly:false },
  { url:"https://www.marktechpost.com/feed/",             src:"MarkTechPost", label:"MarkTechPost",   aiOnly:true },
  { url:"https://bdtechtalks.com/feed/",                  src:"TechTalks",   label:"BD Tech Talks",   aiOnly:false },
  { url:"https://thesequence.substack.com/feed",          src:"TheSequence", label:"The Sequence",    aiOnly:true },
  { url:"https://www.aiweekly.co/feed",                   src:"AIWeekly",    label:"AI Weekly",       aiOnly:true },
  { url:"https://lastweekin.ai/feed",                     src:"LastWeekInAI",label:"Last Week in AI", aiOnly:true },
  { url:"https://importai.substack.com/feed",             src:"ImportAI",    label:"Import AI",       aiOnly:true },
  { url:"https://mistral.ai/news/feed.xml", src:"Mistral", label:"Mistral AI", aiOnly:true },
  { url:"https://www.together.ai/blog/rss.xml", src:"TogetherAI", label:"Together AI", aiOnly:true },
  { url:"https://wandb.ai/fully-connected/feed", src:"WandB", label:"Weights & Biases", aiOnly:true },
  { url:"https://magazine.sebastianraschka.com/feed", src:"Raschka", label:"Sebastian Raschka", aiOnly:true },
  { url:"https://lilianweng.github.io/feed.xml", src:"LilianWeng", label:"Lilian Weng", aiOnly:true },
  { url:"https://www.fast.ai/feed.xml", src:"FastAI", label:"fast.ai", aiOnly:true },
  { url:"https://www.deeplearning.ai/the-batch/feed/", src:"DeepLearningAI", label:"The Batch", aiOnly:true },
  { url:"https://blog.langchain.dev/rss/", src:"LangChain", label:"LangChain Blog", aiOnly:true },
  { url:"https://cohere.com/blog/rss", src:"Cohere", label:"Cohere Blog", aiOnly:true },
];

// ── Main aggregator ────────────────────────────────────────────────
async function fetchAll() {
  console.log("🔄 Fetching all sources…");
  const results = await Promise.allSettled([
    fetchHN(), fetchArxiv(), fetchDevTo(), fetchDevToML(),
    fetchLobsters(), fetchGitHub(),
    ...RSS_SOURCES.map(s => fetchRSS(s.url, s.src, s.label, s.aiOnly)),
  ]);
  const labels = ["HN","arXiv","Dev.to(AI)","Dev.to(ML)","Lobste.rs","GitHub",...RSS_SOURCES.map(s=>s.label)];
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
  unique.sort((a,b) => b.time - a.time);
  console.log(`✅ Total: ${unique.length} items\n`);
  return unique;
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
let BRIEFING_CACHE = { data: null, ts: 0 };

app.get("/briefing", async (req, res) => {
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
    res.json({ items: CACHE.items, cached: false, age: 0 });
  } catch(err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Health
app.get("/health", (_, res) => res.json({ ok:true, items:CACHE.items.length, lastFetch:CACHE.lastFetch }));

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
    CACHE.items = await fetchAll();
    CACHE.lastFetch = Date.now();
    console.log(`✅ Cache refreshed — ${CACHE.items.length} items`);
  } catch(e) {
    console.error("Auto-refresh failed:", e.message);
  }
}, 5 * 60 * 1000);


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
    const digest = { categories, generatedAt: new Date().toISOString() };
    DIGEST_CACHE = { data:digest, ts:Date.now() };
    res.json(digest);
  } catch(e) {
    console.error("Digest error:", e);
    res.status(500).json({ error: e.message });
  }
});

// ── EMAIL DIGEST ───────────────────────────────────────────────

// ── RATE LIMITER ────────────────────────────────────────────────
const rateLimitMap = new Map();
const rateLimit = (key, maxReqs, windowMs) => {
  const now = Date.now();
  const record = rateLimitMap.get(key) || { count: 0, start: now };
  if(now - record.start > windowMs) {
    rateLimitMap.set(key, { count: 1, start: now });
    return false; // not limited
  }
  record.count++;
  rateLimitMap.set(key, record);
  return record.count > maxReqs; // true = limited
};

import { Resend } from "resend";
const resend = new Resend(process.env.RESEND_API_KEY);

app.post("/send-digest", async (req, res) => {
  try {
    const { email, items } = req.body;
    if(!email || !items?.length) return res.status(400).json({ error: "Missing email or items" });

    const top = items.slice(0, 8);

    const typeColors = {
      model:"#00ff88", research:"#4da6ff", funding:"#ffd700",
      product:"#c77dff", policy:"#ff9f43", drama:"#ff4d6d"
    };

    const rows = top.map(item => {
      const color = typeColors[item.type] || "#c77dff";
      const tags = (item.tags||[]).map(t =>
        `<span style="font-size:10px;padding:2px 6px;border-radius:2px;background:#1a1a2e;color:#8888aa;border:1px solid #111128;margin-right:4px;">${t}</span>`
      ).join("");
      return `
        <div style="padding:16px 0;border-bottom:1px solid #111128;">
          <div style="margin-bottom:8px;">
            <span style="font-size:10px;padding:2px 7px;border-radius:2px;background:${color}22;color:${color};border:1px solid ${color}44;font-weight:600;letter-spacing:0.08em;">${item.type?.toUpperCase()}</span>
          </div>
          <a href="${item.link}" style="color:#d8d8f0;text-decoration:none;font-size:14px;font-weight:500;line-height:1.5;display:block;margin-bottom:8px;">${item.title}</a>
          <p style="color:#8888aa;font-size:12px;line-height:1.6;margin:0 0 8px;">${(item.sum||"").slice(0,200)}${item.sum?.length>200?"…":""}</p>
          ${tags ? `<div style="margin-bottom:4px;">${tags}</div>` : ""}
          <span style="font-size:11px;color:#555570;">${item.srcLabel||item.src} · ${item.timeLabel||""}</span>
        </div>
      `;
    }).join("");

    const html = `
      <!DOCTYPE html>
      <html>
      <head><meta charset="UTF-8"/></head>
      <body style="margin:0;padding:0;background:#050507;font-family:'Courier New',monospace;">
        <div style="max-width:600px;margin:0 auto;padding:32px 24px;">
          <div style="margin-bottom:32px;padding-bottom:24px;border-bottom:1px solid #111128;">
            <div style="font-size:22px;font-weight:700;color:#d8d8f0;letter-spacing:0.2em;margin-bottom:6px;">PULSE</div>
            <div style="font-size:11px;color:#555570;letter-spacing:0.12em;">AI SIGNALS FOR DEVELOPERS · DAILY DIGEST</div>
          </div>
          <div style="margin-bottom:8px;font-size:11px;color:#555570;letter-spacing:0.1em;">TOP STORIES TODAY</div>
          ${rows}
          <div style="margin-top:32px;padding-top:24px;border-top:1px solid #111128;text-align:center;">
            <a href="https://pulse-ui-gilt.vercel.app" style="display:inline-block;padding:10px 24px;background:#00ff88;color:#000;font-size:12px;font-weight:600;letter-spacing:0.1em;text-decoration:none;border-radius:4px;">OPEN PULSE</a>
            <p style="margin-top:16px;font-size:10px;color:#333350;">You're receiving this because you enabled daily digest in Pulse.</p>
          </div>
        </div>
      </body>
      </html>
    `;

    await resend.emails.send({
      from: "Pulse <onboarding@resend.dev>",
      to: email,
      subject: `Pulse Daily · ${top.length} AI signals for you`,
      html,
    });

    res.json({ ok: true });
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
