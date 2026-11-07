// mini-forum 冻结数据集（确定性生成，值永远一致）
//
// 刻意复刻 WebArena / NodeBB 论坛场景的数据形态：
//   - 3 个用户（alice / bob / carol，密码统一 Password.123，localStorage mf_token 认证）；
//   - 4 个分类（General / Tech / Help / News），8 个冻结帖子，id 1-8；
//   - 帖子 #6 有 6 条回复，其中 1 条是嵌套回复（回复的回复）；
//   - 新发帖从 id=9 递增（存 localStorage mf_topics）。
// 生成规则固定，因此分类过滤/搜索/点赞基数等结果都可静态推演（用例断言依赖这一点）。

var MF_USERS = {
  "alice": { password: "Password.123", name: "Alice Chen", email: "alice@example.com", joined: "2021-03-14", posts: 34 },
  "bob":   { password: "Password.123", name: "Bob Smith",  email: "bob@example.com",   joined: "2021-07-02", posts: 57 },
  "carol": { password: "Password.123", name: "Carol Diaz", email: "carol@example.com", joined: "2022-01-20", posts: 12 }
};

var MF_CATEGORIES = ["General", "Tech", "Help", "News"];

var MF_TAGS = ["welcome", "meta", "chrome", "macos", "ssg", "jamstack", "forum", "performance",
  "postgres", "db", "news", "showoff", "csv", "bug", "tech", "help"];

// 回复结构：{ author, text, votes, children: [ ...嵌套回复 ] }
var MF_TOPICS = [
  {
    id: 1, title: "Welcome to the community - read me first", author: "alice",
    category: "General", tags: ["welcome", "meta"], views: 512, votes: 42,
    content: "Welcome! Please read the rules before posting: be kind, stay on topic, and tag your threads so others can find them.",
    replies: [
      { author: "bob", text: "Thanks for setting this up!", votes: 3, children: [] },
      { author: "carol", text: "Happy to be here.", votes: 1, children: [] }
    ]
  },
  {
    id: 2, title: "Chrome hangs with more than 20 tabs on macOS", author: "bob",
    category: "Tech", tags: ["chrome", "macos"], views: 890, votes: 5,
    content: "Since the latest update Chrome freezes for a few seconds whenever I have more than 20 tabs open. Anyone else seeing this on macOS Monterey?",
    replies: [
      { author: "alice", text: "Same here on Big Sur after 110.0.5481.", votes: 2, children: [] },
      { author: "carol", text: "Try disabling the site isolation flags.", votes: 1, children: [
        { author: "bob", text: "That fixed it for me, thanks!", votes: 1, children: [] }
      ] }
    ]
  },
  {
    id: 3, title: "How do I choose a static site generator?", author: "carol",
    category: "Help", tags: ["ssg", "jamstack"], views: 233, votes: 8,
    content: "I need a simple blog with Markdown sources and zero runtime. Hugo, Eleventy or Astro?",
    replies: [
      { author: "alice", text: "Eleventy if you want plain JS, Hugo if you want raw speed.", votes: 4, children: [] }
    ]
  },
  {
    id: 4, title: "NodeBB vs Discourse: a performance comparison", author: "bob",
    category: "Tech", tags: ["forum", "performance"], views: 641, votes: 19,
    content: "I benchmarked both with 500 concurrent browsing sessions. NodeBB stayed under 200MB of RSS while Discourse needed 1.2GB.",
    replies: [
      { author: "carol", text: "Discourse trades memory for search though.", votes: 2, children: [] }
    ]
  },
  {
    id: 5, title: "Postgres query slow after upgrading to 14", author: "alice",
    category: "Help", tags: ["postgres", "db"], views: 377, votes: 11,
    content: "A query that took 40ms on 13 now takes 900ms on 14. EXPLAIN shows the planner switched from a hash join to a nested loop.",
    replies: [
      { author: "bob", text: "Run ANALYZE, the statistics format changed between majors.", votes: 6, children: [] }
    ]
  },
  {
    id: 6, title: "Weekly news digest: browser engines and web standards", author: "carol",
    category: "News", tags: ["news"], views: 456, votes: 27,
    content: "This week: the Blink scheduler fix landed, WebKit shipped responsive images improvements, and Firefox published its compatibility report.",
    replies: [
      { author: "bob", text: "The Blink scheduler fix is the big one.", votes: 4, children: [] },
      { author: "alice", text: "WebKit also landed the responsive images work.", votes: 2, children: [
        { author: "carol", text: "Exactly - the srcset behavior finally matches the spec.", votes: 3, children: [] }
      ] },
      { author: "bob", text: "Firefox shipped the new baseline compiler too.", votes: 1, children: [] },
      { author: "alice", text: "The interop dashboard was updated as well.", votes: 2, children: [] },
      { author: "bob", text: "Great digest as always.", votes: 1, children: [] }
    ]
  },
  {
    id: 7, title: "Show your desktop setup (June edition)", author: "bob",
    category: "General", tags: ["showoff"], views: 298, votes: 15,
    content: "Post a photo of your battlestation. Winner gets bragging rights until July.",
    replies: [
      { author: "carol", text: "Mac mini with a vertical monitor stand.", votes: 2, children: [] },
      { author: "alice", text: "Two 27 inch 4K displays and a very tired 2019 Intel MBP.", votes: 3, children: [] }
    ]
  },
  {
    id: 8, title: "Uploading large CSV files fails silently", author: "alice",
    category: "Help", tags: ["csv", "bug"], views: 190, votes: 4,
    content: "Files over 10MB return HTTP 200 but never appear in storage. Nothing in the logs either.",
    replies: [
      { author: "bob", text: "Check the client_max_body_size on your reverse proxy.", votes: 5, children: [] }
    ]
  }
];
