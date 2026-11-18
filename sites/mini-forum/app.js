// mini-forum 共享逻辑（NodeBB 论坛复刻）
//
// 本站刻意复刻 WebArena / NodeBB 论坛场景踩过的两个"陷阱"，作为负载验证的
// 关键交互模式（社区 / UGC 类站点普遍存在同类交互）：
//
//   [陷阱F1] 发帖页的标签选择器是自定义 div 下拉：#tag-dropdown 内的选项在点击
//           #tag-dropdown-toggle 展开面板后才懒渲染进 DOM。CLI 的 select 指令只
//           作用于原生 <select>，对它无效；必须 click 展开 + click 选项两步。
//           发帖提交校验（标题 / contenteditable 正文 / 标签任一为空）在处理器内
//           直接 return + 行内报错，不发生导航——rc==0 但 URL 不变。
//   [陷阱F2] 未登录点赞静默拦截：.upvote-btn 的处理器里先检查登录态，
//           未登录点击直接 return——rc==0、无报错、无导航、票数不变
//           （指令成功 ≠ 功能成功）。
//   其他拟真点：帖子正文是 contenteditable 富文本编辑器（#editor）；
//           首页搜索是普通 form GET（正常对照组，对照 F1/F2 的非标准交互）；
//           分类过滤是真实链接导航（?category=Tech）；回复树含嵌套层级（ol>li>ol）。

var MF = {
  esc: function (s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  },

  // ---- 认证（localStorage mf_token）----
  login: function (username, pass) {
    var u = MF_USERS[username];
    if (u && u.password === pass) {
      localStorage.setItem("mf_token", username);
      return u;
    }
    return null;
  },
  logout: function () { localStorage.removeItem("mf_token"); },
  user: function () {
    var t = localStorage.getItem("mf_token");
    return t && MF_USERS[t] ? MF_USERS[t] : null;
  },
  requireAuth: function () {
    if (!MF.user()) {
      window.location.replace("/login.html");
      return false;
    }
    return true;
  },

  // ---- 顶栏 ----
  renderHeader: function () {
    var h = document.getElementById("site-header");
    if (!h) return;
    var u = MF.user();
    var right = u
      ? "<a class='btn-compose' href='/compose.html'>New Topic</a>" +
        "<span class='header-user'>" + MF.esc(u.name) + "</span><a href='#' id='header-signout'>Sign out</a>"
      : "<a class='btn-compose' href='/compose.html'>New Topic</a><a href='/login.html'>Log in</a>";
    h.innerHTML = "<a class='logo' href='/'>nodeforum</a>" +
      "<nav class='site-nav'><a href='/'>Topics</a><a href='/user.html'>Members</a><a href='/settings.html'>Settings</a></nav>" +
      "<div class='header-right'>" + right + "</div>";
    var so = document.getElementById("header-signout");
    if (so) so.addEventListener("click", function () {
      MF.logout();
      window.location.href = "/";
    });
  },

  // ---- 数据层：新建帖 / 追加回复 / 点赞持久化在 localStorage ----
  loadTopics: function () {
    try { return JSON.parse(localStorage.getItem("mf_topics") || "[]"); }
    catch (e) { return []; }
  },
  saveTopics: function (l) { localStorage.setItem("mf_topics", JSON.stringify(l)); },
  allTopics: function () { return MF_TOPICS.concat(MF.loadTopics()); },
  findTopic: function (id) {
    var hit = MF.allTopics().filter(function (t) { return t.id === id; });
    return hit[0] || null;
  },
  loadReplies: function (topicId) {
    try { return JSON.parse(localStorage.getItem("mf_replies_" + topicId) || "[]"); }
    catch (e) { return []; }
  },
  saveReplies: function (topicId, list) {
    localStorage.setItem("mf_replies_" + topicId, JSON.stringify(list));
  },
  allReplies: function (t) { return t.replies.concat(MF.loadReplies(t.id)); },
  loadVotes: function () {
    try { return JSON.parse(localStorage.getItem("mf_votes") || "{}"); }
    catch (e) { return {}; }
  },
  saveVotes: function (v) { localStorage.setItem("mf_votes", JSON.stringify(v)); },

  countReplies: function (replies) {
    var n = 0;
    (replies || []).forEach(function (r) {
      n += 1 + MF.countReplies(r.children);
    });
    return n;
  },
  tagSpans: function (tags) {
    return (tags || []).map(function (t) {
      return "<span class='tag'>" + MF.esc(t) + "</span>";
    }).join(" ");
  },

  // ---- 首页：分类过滤 + form GET 搜索（正常对照组）----
  renderIndex: function () {
    var list = document.getElementById("topic-list");
    if (!list) return;
    var p = new URLSearchParams(window.location.search);
    var cat = p.get("category") || "";
    var q = (p.get("q") || "").toLowerCase();
    if (p.get("q") !== null) {
      var si = document.getElementById("search-input");
      if (si) si.value = p.get("q");
    }

    var bar = document.getElementById("category-bar");
    if (bar) {
      var html = "<a class='cat-link" + (cat ? "" : " active") + "' href='/'>All</a> ";
      MF_CATEGORIES.forEach(function (c) {
        html += "<a class='cat-link" + (cat === c ? " active" : "") +
          "' href='/?category=" + encodeURIComponent(c) + "'>" + c + "</a> ";
      });
      bar.innerHTML = html;
    }

    var topics = MF.allTopics().filter(function (t) {
      if (cat && t.category !== cat) return false;
      if (q && t.title.toLowerCase().indexOf(q) === -1) return false;
      return true;
    }).sort(function (a, b) { return b.id - a.id; });

    var html = "";
    if (!topics.length) {
      html = "<tr><td colspan='4' class='empty'>No topics match your search.</td></tr>";
    }
    topics.forEach(function (t) {
      html += "<tr class='topic-row' data-id='" + t.id + "'>" +
        "<td class='cell-topic'><a class='topic-link' href='/topic/" + t.id + "/'>" +
        MF.esc(t.title) + "</a><div class='topic-tags'>" + MF.tagSpans(t.tags) + "</div></td>" +
        "<td><a class='category-link' data-cat='" + t.category + "' href='/?category=" +
        encodeURIComponent(t.category) + "'>" + t.category + "</a></td>" +
        "<td class='cell-replies'>" + MF.countReplies(MF.allReplies(t)) + "</td>" +
        "<td class='cell-views'>" + t.views + "</td></tr>";
    });
    list.innerHTML = html;
    document.title = (cat ? cat + " - " : "") + "nodeforum";
  },

  // ---- 帖子详情：嵌套回复树 + 点赞（[陷阱F2]）----
  renderTopic: function () {
    var box = document.getElementById("topic-detail");
    if (!box) return;
    var m = window.location.pathname.match(/\/topic\/(\d+)/);
    var id = m ? parseInt(m[1], 10) :
      parseInt(new URLSearchParams(window.location.search).get("id") || "0", 10);
    var t = MF.findTopic(id);
    if (!t) {
      box.innerHTML = "<h1>Topic not found</h1>" +
        "<p>This topic does not exist or has been removed.</p>" +
        "<a class='btn' href='/'>Back to topics</a>";
      return;
    }
    var author = MF_USERS[t.author] || { name: t.author };
    var replies = MF.allReplies(t);
    var votes = MF.loadVotes();

    var replyLi = function (r, postId, depth) {
      var u = MF_USERS[r.author] || { name: r.author };
      var html = "<li class='reply-item'><div class='reply' id='post-" + postId + "'>" +
        "<div class='post-head'><span class='post-author'>" + MF.esc(u.name) + "</span>" +
        "<span class='post-body'>" + MF.esc(r.text) + "</span></div>" +
        "<div class='post-foot'>" +
          "<button class='upvote-btn' data-post='" + postId + "' data-base='" + r.votes + "'>&#9650;</button>" +
          "<span class='votes-count' id='votes-" + postId + "' data-base='" + r.votes + "'>" +
          (r.votes + (votes[postId] ? 1 : 0)) + "</span>" +
        "</div></div>";
      if (r.children && r.children.length) {
        html += "<ol class='reply-list nested'>";
        r.children.forEach(function (c, i) {
          html += replyLi(c, postId + "-c" + i, depth + 1);
        });
        html += "</ol>";
      }
      html += "</li>";
      return html;
    };

    var repliesHtml = "";
    replies.forEach(function (r, i) { repliesHtml += replyLi(r, "t" + t.id + "-r" + i, 0); });

    box.innerHTML =
      "<h1 id='topic-title'>" + MF.esc(t.title) + "</h1>" +
      "<div id='topic-meta'>Topic #" + t.id + " &middot; <a class='category-link' data-cat='" +
        t.category + "' href='/?category=" + encodeURIComponent(t.category) + "'>" + t.category +
        "</a> &middot; started by <span id='topic-author'>" + MF.esc(author.name) + "</span>" +
        " &middot; " + t.views + " views &middot; " + MF.tagSpans(t.tags) + "</div>" +
      "<article class='post main-post' id='post-t" + t.id + "'>" +
        "<div class='post-head'><span class='post-author'>" + MF.esc(author.name) + "</span>" +
        "<div class='post-body' id='main-content'>" + MF.esc(t.content) + "</div></div>" +
        "<div class='post-foot'>" +
          "<button class='upvote-btn' id='upvote-t" + t.id + "' data-post='t" + t.id +
            "' data-base='" + t.votes + "'>&#9650; upvote</button>" +
          "<span class='votes-count' id='votes-t" + t.id + "' data-base='" + t.votes + "'>" +
          (t.votes + (votes["t" + t.id] ? 1 : 0)) + "</span>" +
        "</div>" +
      "</article>" +
      "<h2 id='replies-heading'><span id='reply-count'>" + MF.countReplies(replies) +
      "</span> replies</h2>" +
      "<ol class='reply-list' id='replies'>" + repliesHtml + "</ol>" +
      "<div class='reply-box'>" +
        "<textarea id='reply-content' rows='3' placeholder='Reply to this topic&hellip;'></textarea>" +
        "<button class='btn-primary' id='reply-submit' type='button'>Reply</button>" +
        "<div class='err' id='reply-err'></div>" +
      "</div>";
    document.title = t.title + " - nodeforum";
    MF.initTopicActions(t);
  },

  initTopicActions: function (t) {
    // 点赞：未登录静默拦截（[陷阱F2]）；已登录切换票（再点一次取消）
    document.getElementById("topic-detail").addEventListener("click", function (e) {
      var btn = e.target.closest(".upvote-btn");
      if (btn) {
        if (!MF.user()) return; // [陷阱F2] 静默 return：rc==0、票数不变、无导航
        var postId = btn.dataset.post;
        var votes = MF.loadVotes();
        if (votes[postId]) delete votes[postId]; else votes[postId] = 1;
        MF.saveVotes(votes);
        var span = document.getElementById("votes-" + postId);
        span.textContent = String(parseInt(span.dataset.base, 10) + (votes[postId] ? 1 : 0));
        return;
      }
      var cl = e.target.closest("a.category-link");
      if (cl) return; // 正常链接导航
    });
    document.getElementById("reply-submit").addEventListener("click", function () {
      var err = document.getElementById("reply-err");
      if (!MF.user()) { err.textContent = "Please log in to reply."; return; }
      var content = (document.getElementById("reply-content").value || "").trim();
      if (!content) { err.textContent = "Reply content cannot be empty."; return; }
      var list = MF.loadReplies(t.id);
      list.push({ author: MF.user() && localStorage.getItem("mf_token"), text: content, votes: 0, children: [] });
      MF.saveReplies(t.id, list);
      MF.renderTopic();
    });
  },

  // ---- 发帖页（[陷阱F1] 自定义 div 标签下拉 + 静默校验）----
  composeTags: [],
  initCompose: function () {
    var toggle = document.getElementById("tag-dropdown-toggle");
    if (!toggle) return;
    var dd = document.getElementById("tag-dropdown");
    toggle.addEventListener("click", function () {
      if (!dd.dataset.rendered) {
        var html = "";
        MF_TAGS.forEach(function (tg) {
          html += "<a class='tag-option' data-value='" + tg + "' href='#'>" + tg + "</a>";
        });
        dd.innerHTML = html;
        dd.dataset.rendered = "1";
      }
      dd.classList.toggle("open");
    });
    dd.addEventListener("click", function (e) {
      var opt = e.target.closest(".tag-option");
      if (!opt) return;
      e.preventDefault();
      var v = opt.dataset.value;
      var i = MF.composeTags.indexOf(v);
      if (i === -1) { MF.composeTags.push(v); opt.classList.add("selected"); }
      else { MF.composeTags.splice(i, 1); opt.classList.remove("selected"); }
      document.getElementById("selected-tags").innerHTML =
        MF.composeTags.map(function (tg) { return "<span class='tag'>" + MF.esc(tg) + "</span>"; }).join(" ");
      dd.classList.remove("open");
    });
    document.getElementById("submit-btn").addEventListener("click", function () {
      var err = document.getElementById("compose-err");
      var title = (document.getElementById("post-title").value || "").trim();
      var content = (document.getElementById("editor").textContent || "").trim();
      if (!title) { err.textContent = "Title is required."; return; }
      if (!content) { err.textContent = "Post content is required."; return; }
      if (!MF.composeTags.length) { err.textContent = "Please pick at least one tag."; return; }
      var created = MF.loadTopics();
      var t = {
        id: 9 + created.length,
        title: title,
        author: localStorage.getItem("mf_token"),
        category: "General",
        tags: MF.composeTags.slice(),
        views: 0,
        votes: 0,
        content: content,
        replies: []
      };
      created.push(t);
      MF.saveTopics(created);
      window.location.href = "/topic/" + t.id + "/";
    });
  },

  // ---- 成员搜索页 ----
  renderUsers: function (query) {
    var box = document.getElementById("user-results");
    if (!box) return;
    var q = (query || "").toLowerCase();
    var users = Object.keys(MF_USERS).filter(function (name) {
      if (!q) return true;
      var u = MF_USERS[name];
      return name.toLowerCase().indexOf(q) !== -1 || u.name.toLowerCase().indexOf(q) !== -1;
    });
    var html = "";
    if (!users.length) html = "<li class='user-row empty'>No members found.</li>";
    users.forEach(function (name) {
      var u = MF_USERS[name];
      html += "<li class='user-row' data-user='" + name + "'><strong class='user-name'>" +
        MF.esc(u.name) + "</strong> <span class='user-handle'>@" + name + "</span>" +
        "<div class='user-meta'>" + MF.esc(u.email) + " &middot; joined " + u.joined +
        " &middot; " + u.posts + " posts</div></li>";
    });
    box.innerHTML = html;
  },
  initUsers: function () {
    if (!document.getElementById("user-results")) return;
    MF.renderUsers("");
    document.getElementById("user-search-btn").addEventListener("click", function () {
      MF.renderUsers(document.getElementById("user-search").value || "");
    });
  },

  // ---- 登录页 ----
  initLogin: function () {
    var form = document.getElementById("login-form");
    if (!form) return;
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var u = (document.getElementById("username").value || "").trim();
      var p = document.getElementById("password").value || "";
      var rec = MF.login(u, p);
      if (!rec) {
        document.getElementById("login-err").textContent = "Invalid username or password.";
        return;
      }
      window.location.href = "/";
    });
  }
};
